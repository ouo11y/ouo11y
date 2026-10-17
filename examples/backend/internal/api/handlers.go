// Package api holds the HTTP handlers of the demo backend. Every handler
// opens at least one child span so traces that start in the browser or on
// mobile look realistic once they reach Tempo.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/ouo11y/ouo11y/examples/backend/internal/telemetry"
)

const (
	instrumentationName = "github.com/ouo11y/ouo11y/examples/backend"
	anonymousUser       = "anonymous"
	brokenCard          = "broken-card"
	healthPath          = "/healthz"
)

// Server is the demo backend HTTP API.
type Server struct {
	store  *Store
	tp     trace.TracerProvider
	tracer trace.Tracer
	prop   propagation.TextMapPropagator

	requests metric.Int64Counter
	orders   metric.Int64Counter
	checkout metric.Float64Histogram
}

// Option configures a Server.
type Option func(*Server)

// WithTracerProvider overrides the tracer provider (tests use an in-memory one).
func WithTracerProvider(tp trace.TracerProvider) Option {
	return func(s *Server) { s.tp = tp; s.tracer = tp.Tracer(instrumentationName) }
}

// WithPropagator overrides the propagator otelhttp extracts context with.
func WithPropagator(p propagation.TextMapPropagator) Option {
	return func(s *Server) { s.prop = p }
}

// WithMeterProvider overrides the meter provider.
func WithMeterProvider(mp metric.MeterProvider) Option {
	return func(s *Server) { s.initMetrics(mp) }
}

// New builds a Server with the global OTel providers unless overridden.
func New(opts ...Option) *Server {
	s := &Server{store: NewStore(), prop: otel.GetTextMapPropagator()}
	WithTracerProvider(otel.GetTracerProvider())(s)
	s.initMetrics(otel.GetMeterProvider())
	for _, o := range opts {
		o(s)
	}
	return s
}

func (s *Server) initMetrics(mp metric.MeterProvider) {
	m := mp.Meter(instrumentationName)
	s.requests, _ = m.Int64Counter("ouo.demo.requests",
		metric.WithDescription("API requests handled by the demo backend"), metric.WithUnit("{request}"))
	s.orders, _ = m.Int64Counter("ouo.demo.orders",
		metric.WithDescription("Checkout outcomes"), metric.WithUnit("{order}"))
	s.checkout, _ = m.Float64Histogram("ouo.demo.checkout.duration",
		metric.WithDescription("Checkout handler duration"), metric.WithUnit("s"))
}

// Handler returns the fully wired HTTP handler: CORS -> otelhttp server span
// -> router -> per-route middleware (route naming, request log, faults).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.route(mux, "GET "+healthPath, s.handleHealth, false)
	s.route(mux, "GET /api/products", s.handleListProducts, true)
	s.route(mux, "GET /api/products/{id}", s.handleGetProduct, true)
	s.route(mux, "GET /api/cart", s.handleGetCart, true)
	s.route(mux, "POST /api/cart", s.handleAddToCart, true)
	s.route(mux, "POST /api/checkout", s.handleCheckout, true)

	// otelhttp (>= v0.60) reads http.Request.Pattern after the mux matched,
	// renames the server span to "{method} {route}" and sets http.route on
	// its own, so no per-route span naming is needed here.
	return CORS(otelhttp.NewHandler(mux, "http.server",
		otelhttp.WithTracerProvider(s.tp),
		otelhttp.WithPropagators(s.prop),
		// The container HEALTHCHECK polls /healthz every few seconds; keep
		// that noise out of Tempo.
		otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != healthPath }),
	))
}

// route registers pattern on mux with the per-route middleware chain.
func (s *Server) route(mux *http.ServeMux, pattern string, h http.HandlerFunc, faults bool) {
	var handler http.Handler = h
	if faults {
		handler = s.withFaults(handler)
	}
	mux.Handle(pattern, s.instrument(pattern, handler))
}

// instrument sets http.route on the server span, counts the request and
// writes one info log line per request carrying session.id and user.id from
// baggage. (otelhttp names the span from r.Pattern after the handler returns
// but computes span attributes before routing, so http.route is set here.)
func (s *Server) instrument(pattern string, next http.Handler) http.Handler {
	method, route, _ := strings.Cut(pattern, " ")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		start := time.Now()
		trace.SpanFromContext(ctx).SetAttributes(semconv.HTTPRoute(route))

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		attrs := []attribute.KeyValue{
			semconv.HTTPRequestMethodKey.String(method),
			semconv.HTTPRoute(route),
			semconv.HTTPResponseStatusCode(rec.status),
		}
		s.requests.Add(ctx, 1, metric.WithAttributes(attrs...))
		if route == healthPath {
			return // not logged either; see WithFilter above
		}

		logAttrs := []any{
			"http.request.method", method,
			"http.route", route,
			"url.path", r.URL.Path,
			"http.response.status_code", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
		}
		if q := r.URL.RawQuery; q != "" {
			logAttrs = append(logAttrs, "url.query", q)
		}
		logAttrs = append(logAttrs, identityLogAttrs(ctx)...)
		slog.InfoContext(ctx, "request", logAttrs...)
	})
}

// --- handlers ---------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleListProducts(w http.ResponseWriter, r *http.Request) {
	ctx, span := s.tracer.Start(r.Context(), "inventory.lookup",
		trace.WithAttributes(attribute.String("inventory.scope", "catalogue")))
	defer span.End()
	s.slowQuery(ctx, 3*time.Millisecond, "SELECT id, name, price, image FROM products ORDER BY id")
	list := s.store.Products()
	span.SetAttributes(attribute.Int("inventory.count", len(list)))
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleGetProduct(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, span := s.tracer.Start(r.Context(), "inventory.lookup",
		trace.WithAttributes(attribute.String("product.id", id)))
	defer span.End()
	s.slowQuery(ctx, 2*time.Millisecond, "SELECT id, name, price, image FROM products WHERE id = $1")
	p, ok := s.store.Product(id)
	if !ok {
		span.SetStatus(codes.Error, "product not found")
		writeError(w, http.StatusNotFound, "product not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleGetCart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := userID(r)
	ctx, span := s.tracer.Start(ctx, "cart.load", trace.WithAttributes(attribute.String("user.id", user)))
	defer span.End()
	s.slowQuery(ctx, 2*time.Millisecond, "SELECT product_id, qty FROM cart_items WHERE user_id = $1")
	writeJSON(w, http.StatusOK, s.store.Cart(user))
}

type addToCartRequest struct {
	ProductID string `json:"productId"`
	Qty       int    `json:"qty"`
}

func (s *Server) handleAddToCart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body addToCartRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if body.ProductID == "" {
		writeError(w, http.StatusBadRequest, "productId is required")
		return
	}
	if body.Qty == 0 {
		body.Qty = 1
	}
	user := userID(r)

	ctx, span := s.tracer.Start(ctx, "inventory.lookup",
		trace.WithAttributes(attribute.String("product.id", body.ProductID), attribute.Int("cart.qty", body.Qty)))
	s.slowQuery(ctx, 2*time.Millisecond, "SELECT stock FROM inventory WHERE product_id = $1 FOR UPDATE")
	cart, err := s.store.AddToCart(user, body.ProductID, body.Qty)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		span.End()
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	span.End()

	_, upd := s.tracer.Start(ctx, "db.query", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		semconv.DBSystemNamePostgreSQL,
		semconv.DBQueryText("INSERT INTO cart_items (user_id, product_id, qty) VALUES ($1, $2, $3) ON CONFLICT DO UPDATE SET qty = cart_items.qty + $3"),
		attribute.String("db.operation.name", "INSERT"),
	))
	upd.End()
	writeJSON(w, http.StatusOK, cart)
}

type checkoutRequest struct {
	PaymentMethod string `json:"paymentMethod"`
}

type checkoutResponse struct {
	OrderID string  `json:"orderId"`
	Total   float64 `json:"total"`
	Items   int     `json:"items"`
}

func (s *Server) handleCheckout(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	var body checkoutRequest
	if err := decodeJSON(r, &body); err != nil && !errors.Is(err, errEmptyBody) {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if body.PaymentMethod == "" {
		body.PaymentMethod = "card"
	}
	user := userID(r)
	cart := s.store.Cart(user)

	// Reserve stock.
	invCtx, inv := s.tracer.Start(ctx, "inventory.lookup",
		trace.WithAttributes(attribute.Int("cart.items", cart.ItemCount)))
	s.slowQuery(invCtx, 3*time.Millisecond, "UPDATE inventory SET stock = stock - $2 WHERE product_id = $1")
	inv.End()

	// Charge. "broken-card" is the deterministic failure path of the demo.
	payCtx, pay := s.tracer.Start(ctx, "payment.charge", trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("payment.method", body.PaymentMethod),
			attribute.Float64("payment.amount", cart.Total),
			attribute.String("payment.currency", "USD"),
			attribute.String("peer.service", "payment-gateway"),
		))
	time.Sleep(5 * time.Millisecond)
	if body.PaymentMethod == brokenCard {
		pay.RecordError(errPaymentGateway)
		pay.SetStatus(codes.Error, errPaymentGateway.Error())
		pay.End()
		s.orders.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "failed")))
		s.checkout.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("outcome", "failed")))
		s.fail(payCtx, w, errPaymentGateway)
		return
	}
	pay.SetAttributes(attribute.String("payment.status", "approved"))
	pay.End()

	orderID, total, items := s.store.Checkout(user)
	_, ins := s.tracer.Start(ctx, "db.query", trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
		semconv.DBSystemNamePostgreSQL,
		semconv.DBQueryText("INSERT INTO orders (id, user_id, total) VALUES ($1, $2, $3)"),
		attribute.String("db.operation.name", "INSERT"),
	))
	ins.End()

	trace.SpanFromContext(ctx).SetAttributes(attribute.String("order.id", orderID))
	s.orders.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "ok")))
	s.checkout.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("outcome", "ok")))
	slog.InfoContext(ctx, "order placed", append([]any{"order.id", orderID, "total", total, "items", items}, identityLogAttrs(ctx)...)...)
	writeJSON(w, http.StatusOK, checkoutResponse{OrderID: orderID, Total: total, Items: items})
}

// --- helpers ----------------------------------------------------------------

// userID resolves the user from baggage user.id, then the x-user-id header,
// then "anonymous".
func userID(r *http.Request) string {
	if v := telemetry.BaggageValue(r.Context(), "user.id"); v != "" {
		return v
	}
	if v := strings.TrimSpace(r.Header.Get("x-user-id")); v != "" {
		return v
	}
	return anonymousUser
}

// identityLogAttrs returns slog attributes for every ouo baggage member
// present (session.id, user.id, ouo.platform).
func identityLogAttrs(ctx context.Context) []any {
	var out []any
	for _, kv := range telemetry.AttributesFromBaggage(ctx) {
		out = append(out, string(kv.Key), kv.Value.AsString())
	}
	return out
}

var errEmptyBody = errors.New("empty body")

func decodeJSON(r *http.Request, v any) error {
	if r.Body == nil || r.ContentLength == 0 {
		return errEmptyBody
	}
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<16))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, errEmptyBody) {
			return errEmptyBody
		}
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// statusRecorder captures the status code for logging and metrics.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status = code
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.wroteHeader = true
	}
	return r.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
