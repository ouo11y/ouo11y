package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/ZiadMansourM/ouo/examples/backend/internal/telemetry"
)

func newTestServer(t *testing.T) (http.Handler, *tracetest.InMemoryExporter) {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(telemetry.NewBaggageSpanProcessor()),
		sdktrace.WithSyncer(exp),
	)
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	s := New(
		WithTracerProvider(tp),
		WithMeterProvider(sdkmetric.NewMeterProvider()),
		WithPropagator(telemetry.NewPropagator()),
	)
	return s.Handler(), exp
}

func do(t *testing.T, h http.Handler, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *strings.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	} else {
		rdr = strings.NewReader("")
	}
	req := httptest.NewRequest(method, target, rdr)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
}

func findSpan(spans tracetest.SpanStubs, name string) (tracetest.SpanStub, bool) {
	for _, s := range spans {
		if s.Name == name {
			return s, true
		}
	}
	return tracetest.SpanStub{}, false
}

func serverSpan(t *testing.T, spans tracetest.SpanStubs) tracetest.SpanStub {
	t.Helper()
	for _, s := range spans {
		if s.SpanKind == trace.SpanKindServer {
			return s
		}
	}
	t.Fatalf("no server span among %d spans", len(spans))
	return tracetest.SpanStub{}
}

func TestHealthz(t *testing.T) {
	h, exp := newTestServer(t)
	rec := do(t, h, http.MethodGet, "/healthz", "", nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"status":"ok"}` {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
	if n := len(exp.GetSpans()); n != 0 {
		t.Errorf("/healthz must not produce spans, got %d", n)
	}
}

func TestProductsListAndGet(t *testing.T) {
	h, exp := newTestServer(t)
	rec := do(t, h, http.MethodGet, "/api/products", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var list []Product
	decode(t, rec, &list)
	if len(list) != 6 {
		t.Fatalf("expected 6 products, got %d", len(list))
	}
	if _, ok := findSpan(exp.GetSpans(), "inventory.lookup"); !ok {
		t.Error("expected an inventory.lookup child span")
	}
	ss := serverSpan(t, exp.GetSpans())
	if ss.Name != "GET /api/products" {
		t.Errorf("server span name = %q, want %q", ss.Name, "GET /api/products")
	}
	exp.Reset()

	rec = do(t, h, http.MethodGet, "/api/products/"+list[0].ID, "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}
	ss = serverSpan(t, exp.GetSpans())
	if ss.Name != "GET /api/products/{id}" {
		t.Errorf("server span name = %q, want route pattern", ss.Name)
	}
	if route, _ := attr(ss, "http.route"); route != "/api/products/{id}" {
		t.Errorf("http.route = %q, want /api/products/{id}", route)
	}
	if rec = do(t, h, http.MethodGet, "/api/products/nope", "", nil); rec.Code != http.StatusNotFound {
		t.Errorf("unknown product: got %d", rec.Code)
	}
}

func TestCartIsPerUserFromBaggageOrHeader(t *testing.T) {
	h, _ := newTestServer(t)
	var cart Cart

	rec := do(t, h, http.MethodPost, "/api/cart", `{"productId":"p-1002","qty":2}`, map[string]string{"baggage": "session.id=s1,user.id=alice"})
	if rec.Code != http.StatusOK {
		t.Fatalf("add: %d %s", rec.Code, rec.Body.String())
	}
	decode(t, rec, &cart)
	if cart.UserID != "alice" || cart.ItemCount != 2 || cart.Total != 49 {
		t.Errorf("alice cart = %+v", cart)
	}

	rec = do(t, h, http.MethodGet, "/api/cart", "", map[string]string{"x-user-id": "bob"})
	decode(t, rec, &cart)
	if cart.UserID != "bob" || cart.ItemCount != 0 {
		t.Errorf("bob cart = %+v", cart)
	}

	rec = do(t, h, http.MethodGet, "/api/cart", "", nil)
	decode(t, rec, &cart)
	if cart.UserID != anonymousUser {
		t.Errorf("anonymous cart = %+v", cart)
	}

	// Baggage wins over the header.
	rec = do(t, h, http.MethodGet, "/api/cart", "", map[string]string{"baggage": "user.id=alice", "x-user-id": "bob"})
	decode(t, rec, &cart)
	if cart.UserID != "alice" || cart.ItemCount != 2 {
		t.Errorf("baggage precedence: %+v", cart)
	}

	if rec = do(t, h, http.MethodPost, "/api/cart", `{"productId":"nope"}`, nil); rec.Code != http.StatusNotFound {
		t.Errorf("unknown product add: %d", rec.Code)
	}
	if rec = do(t, h, http.MethodPost, "/api/cart", `{bad json`, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("bad json: %d", rec.Code)
	}
}

func TestCheckoutOKAndBrokenCard(t *testing.T) {
	h, exp := newTestServer(t)
	hdr := map[string]string{"baggage": "session.id=sess-1,user.id=carol"}
	do(t, h, http.MethodPost, "/api/cart", `{"productId":"p-1001","qty":1}`, hdr)
	exp.Reset()

	rec := do(t, h, http.MethodPost, "/api/checkout", `{"paymentMethod":"card"}`, hdr)
	if rec.Code != http.StatusOK {
		t.Fatalf("checkout: %d %s", rec.Code, rec.Body.String())
	}
	var out checkoutResponse
	decode(t, rec, &out)
	if out.OrderID == "" || out.Total != 129 {
		t.Errorf("checkout response = %+v", out)
	}
	spans := exp.GetSpans()
	for _, name := range []string{"inventory.lookup", "payment.charge", "db.query"} {
		if _, ok := findSpan(spans, name); !ok {
			t.Errorf("missing child span %s", name)
		}
	}
	ss := serverSpan(t, spans)
	if got, _ := attr(ss, "session.id"); got != "sess-1" {
		t.Errorf("server span session.id = %q", got)
	}
	// Cart is emptied after checkout.
	var cart Cart
	decode(t, do(t, h, http.MethodGet, "/api/cart", "", hdr), &cart)
	if cart.ItemCount != 0 {
		t.Errorf("cart not emptied: %+v", cart)
	}
	exp.Reset()

	rec = do(t, h, http.MethodPost, "/api/checkout", `{"paymentMethod":"broken-card"}`, hdr)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("broken-card: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payment gateway unavailable") {
		t.Errorf("body = %s", rec.Body.String())
	}
	pay, ok := findSpan(exp.GetSpans(), "payment.charge")
	if !ok {
		t.Fatal("missing payment.charge span")
	}
	if pay.Status.Code != codes.Error {
		t.Errorf("payment.charge status = %v, want Error", pay.Status.Code)
	}
	if len(pay.Events) == 0 || pay.Events[0].Name != "exception" {
		t.Errorf("payment.charge should have an exception event, got %+v", pay.Events)
	}
	if ss := serverSpan(t, exp.GetSpans()); ss.Status.Code != codes.Error {
		t.Errorf("server span status = %v, want Error", ss.Status.Code)
	}
}

func TestFaultInjection(t *testing.T) {
	h, exp := newTestServer(t)

	start := time.Now()
	rec := do(t, h, http.MethodGet, "/api/products?delay=120", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delay: %d", rec.Code)
	}
	if el := time.Since(start); el < 120*time.Millisecond {
		t.Errorf("delay not applied: took %v", el)
	}
	var dbSpans int
	for _, s := range exp.GetSpans() {
		if s.Name != "db.query" {
			continue
		}
		dbSpans++
		if v, _ := attr(s, "db.system.name"); v != "postgresql" {
			t.Errorf("db.query span db.system.name = %q", v)
		}
		if v, _ := attr(s, "db.query.text"); v == "" {
			t.Errorf("db.query span missing db.query.text")
		}
	}
	if dbSpans == 0 {
		t.Error("expected db.query spans")
	}
	exp.Reset()

	rec = do(t, h, http.MethodGet, "/api/products?fail=500", "", nil)
	if rec.Code != http.StatusInternalServerError || strings.TrimSpace(rec.Body.String()) != `{"error":"payment gateway unavailable"}` {
		t.Fatalf("fail=500: %d %s", rec.Code, rec.Body.String())
	}
	ss := serverSpan(t, exp.GetSpans())
	if ss.Status.Code != codes.Error {
		t.Errorf("fail=500 server span status = %v", ss.Status.Code)
	}
	if len(ss.Events) == 0 || ss.Events[0].Name != "exception" {
		t.Errorf("fail=500 server span should carry an exception event")
	}

	if rec = do(t, h, http.MethodGet, "/api/products?fail=bogus", "", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("fail=bogus: %d", rec.Code)
	}
	if rec = do(t, h, http.MethodGet, "/api/products?delay=abc", "", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("delay=abc: %d", rec.Code)
	}
	// healthz is not subject to faults.
	if rec = do(t, h, http.MethodGet, "/healthz?fail=500", "", nil); rec.Code != http.StatusOK {
		t.Errorf("healthz must ignore faults: %d", rec.Code)
	}
}

func TestTimeoutFaultStopsWhenClientCancels(t *testing.T) {
	h, _ := newTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/products?fail=timeout", nil).WithContext(ctx)
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(httptest.NewRecorder(), req)
		close(done)
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return after client cancellation")
	}
}

func TestCORS(t *testing.T) {
	h, _ := newTestServer(t)

	rec := do(t, h, http.MethodOptions, "/api/products", "", map[string]string{
		"Origin":                         "http://localhost:5173",
		"Access-Control-Request-Method":  "GET",
		"Access-Control-Request-Headers": "traceparent, baggage",
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight: %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Errorf("allow-origin = %q", got)
	}
	for _, hname := range []string{"traceparent", "tracestate", "baggage", "content-type"} {
		if !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), hname) {
			t.Errorf("allow-headers missing %s: %q", hname, rec.Header().Get("Access-Control-Allow-Headers"))
		}
	}

	rec = do(t, h, http.MethodGet, "/api/products", "", map[string]string{"Origin": "http://127.0.0.1:19006"})
	if rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "http://127.0.0.1:19006" {
		t.Errorf("simple request: %d allow-origin=%q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}

	for _, bad := range []string{"https://localhost:5173", "http://evil.example", "http://localhost.evil.example", "http://localhost:80/x"} {
		rec = do(t, h, http.MethodGet, "/api/products", "", map[string]string{"Origin": bad})
		if rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("origin %q must not be allowed", bad)
		}
	}
}

func TestCORSExtraOriginsFromEnv(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "https://demo.example.test, http://192.168.1.10:5173/")
	h, _ := newTestServer(t)
	for _, o := range []string{"https://demo.example.test", "http://192.168.1.10:5173"} {
		rec := do(t, h, http.MethodGet, "/healthz", "", map[string]string{"Origin": o})
		if rec.Header().Get("Access-Control-Allow-Origin") != o {
			t.Errorf("origin %q from CORS_ALLOWED_ORIGINS should be allowed", o)
		}
	}
	rec := do(t, h, http.MethodGet, "/healthz", "", map[string]string{"Origin": "https://other.example.test"})
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("unlisted origin must not be allowed")
	}
}

func attr(s tracetest.SpanStub, key string) (string, bool) {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value.Emit(), true
		}
	}
	return "", false
}
