// Package ingest is the ADR-0007 ingest gateway: it authenticates untrusted
// clients with a public project token, enforces origin, size and rate
// limits, stamps ouo.project.id on every OTLP resource and forwards the
// payload to the collector as protobuf.
package ingest

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	collogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	rpcstatus "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/project"
)

// TokenHeader carries the public project token on every ingest request.
const TokenHeader = "X-Ouo-Project-Token"

// Rejection reasons (metric attribute `reason`), in check order.
const (
	ReasonSize      = "size"
	ReasonToken     = "token"
	ReasonOrigin    = "origin"
	ReasonRate      = "rate"
	ReasonDecode    = "decode"
	ReasonCollector = "collector"
)

// Outcomes (metric attribute `outcome`).
const (
	OutcomeOK       = "ok"
	OutcomeRejected = "rejected"
	OutcomeError    = "error"
)

// Options configure the gateway. Zero values take the ADR-0007 defaults.
type Options struct {
	Registry          *project.Registry
	CollectorEndpoint string        // OUO_COLLECTOR_OTLP_ENDPOINT, default http://otel-collector:4318
	CollectorTimeout  time.Duration // OUO_COLLECTOR_TIMEOUT, default 10s
	MaxBodyBytes      int64         // OUO_MAX_INGEST_BYTES, default 4 MiB; a project's max_body_bytes overrides it
	RateLimitRPS      float64       // OUO_RATE_LIMIT_RPS, default 1000 (per project)
	RateLimitBurst    int           // OUO_RATE_LIMIT_BURST, default 5000
	IPRateLimitRPS    float64       // OUO_IP_RATE_LIMIT_RPS, default 100 (per client IP)
	IPRateLimitBurst  int           // OUO_IP_RATE_LIMIT_BURST, default 300
	TrustProxy        bool          // OUO_TRUST_PROXY: take the client IP from the last X-Forwarded-For hop
	HTTPClient        *http.Client  // to the collector; default: a client with CollectorTimeout
	Now               func() time.Time
	MeterProvider     metric.MeterProvider // default: the global provider
}

// Gateway serves the OTLP ingest routes and authorizes replay uploads.
type Gateway struct {
	registry   *project.Registry
	collector  string
	timeout    time.Duration
	maxBody    int64
	trustProxy bool
	client     *http.Client
	now        func() time.Time
	projects   *ProjectLimiter
	ips        *Limiter
	metrics    metrics
}

// maxCollectorResponse bounds what is copied back from the collector.
const maxCollectorResponse = 1 << 20

// New builds a gateway. Registry is required.
func New(opts Options) (*Gateway, error) {
	if opts.Registry == nil || len(opts.Registry.Projects()) == 0 {
		return nil, project.ErrNoProject
	}
	if opts.CollectorEndpoint == "" {
		opts.CollectorEndpoint = "http://otel-collector:4318"
	}
	if opts.CollectorTimeout <= 0 {
		opts.CollectorTimeout = 10 * time.Second
	}
	if opts.MaxBodyBytes <= 0 {
		opts.MaxBodyBytes = 4 << 20
	}
	if opts.RateLimitRPS == 0 {
		opts.RateLimitRPS = 1000
	}
	if opts.RateLimitBurst == 0 {
		opts.RateLimitBurst = 5000
	}
	if opts.IPRateLimitRPS == 0 {
		opts.IPRateLimitRPS = 100
	}
	if opts.IPRateLimitBurst == 0 {
		opts.IPRateLimitBurst = 300
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: opts.CollectorTimeout}
	}
	if opts.MeterProvider == nil {
		opts.MeterProvider = otel.GetMeterProvider()
	}
	m, err := newMetrics(opts.MeterProvider.Meter("github.com/ZiadMansourM/ouo/services/rum-api/internal/ingest"))
	if err != nil {
		return nil, err
	}
	return &Gateway{
		registry:   opts.Registry,
		collector:  strings.TrimSuffix(opts.CollectorEndpoint, "/"),
		timeout:    opts.CollectorTimeout,
		maxBody:    opts.MaxBodyBytes,
		trustProxy: opts.TrustProxy,
		client:     opts.HTTPClient,
		now:        opts.Now,
		projects:   NewProjectLimiter(opts.RateLimitRPS, opts.RateLimitBurst, opts.Now),
		ips:        NewLimiter(opts.IPRateLimitRPS, opts.IPRateLimitBurst, opts.Now),
		metrics:    m,
	}, nil
}

// Registry exposes the project registry (CORS asks it about origins).
func (g *Gateway) Registry() *project.Registry { return g.registry }

// Handler returns the handler of POST /ingest/otlp/v1/<signal>.
func (g *Gateway) Handler(signal string) http.Handler {
	if _, err := newRequest(signal); err != nil {
		panic(err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.serveOTLP(w, r, signal)
	})
}

// Authorize runs ADR-0007 checks 1 to 4 for a non-OTLP ingest route (the
// replay upload): body size from Content-Length against limit, token,
// Origin and rate limits. On rejection the response is written, the metric
// recorded and nil returned. The route reads and validates the body itself.
func (g *Gateway) Authorize(w http.ResponseWriter, r *http.Request, signal string, limit int64) *project.Project {
	p, _, ok := g.check(w, r, signal, func(*project.Project) int64 { return limit })
	if !ok {
		return nil
	}
	return p
}

// RecordAccepted counts a successful ingest of n decompressed bytes.
func (g *Gateway) RecordAccepted(ctx context.Context, projectID, signal string, n int64) {
	g.metrics.accepted(ctx, projectID, signal, n)
}

// RecordRejected counts a rejection decided by the route itself (for the
// replay upload: size and decode).
func (g *Gateway) RecordRejected(ctx context.Context, projectID, signal, reason string) {
	g.metrics.rejected(ctx, projectID, signal, reason)
}

// check is the shared check sequence. limitFor gives the body limit once
// the project is known (nil when the token is unknown); the Content-Length
// precheck is what makes an oversized body a 413 before a 401.
func (g *Gateway) check(w http.ResponseWriter, r *http.Request, signal string, limitFor func(*project.Project) int64) (*project.Project, int64, bool) {
	ctx := r.Context()
	token := r.Header.Get(TokenHeader)
	p, known := g.registry.Lookup(token)
	pid := ""
	if known {
		pid = p.ID
	}
	limit := limitFor(p)

	// 1. size
	if r.ContentLength > limit {
		g.metrics.rejected(ctx, pid, signal, ReasonSize)
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("body larger than %d bytes", limit))
		return nil, limit, false
	}
	// 2. token
	if !known {
		g.metrics.rejected(ctx, "", signal, ReasonToken)
		if token == "" {
			writeError(w, http.StatusUnauthorized, "missing "+TokenHeader+" header")
		} else {
			writeError(w, http.StatusUnauthorized, "unknown project token")
		}
		return nil, limit, false
	}
	// 3. origin
	if origin := r.Header.Get("Origin"); origin != "" && !p.AllowsOrigin(origin) {
		g.metrics.rejected(ctx, pid, signal, ReasonOrigin)
		writeError(w, http.StatusForbidden, "origin not allowed for project "+p.ID)
		return nil, limit, false
	}
	// 4. rate: per project, then per client IP
	var rate float64
	var burst int
	if p.RateLimit != nil {
		rate, burst = p.RateLimit.RequestsPerSecond, p.RateLimit.Burst
	}
	if ok, wait := g.projects.Allow(p.ID, rate, burst); !ok {
		g.rateLimited(w, r, pid, signal, "project", wait)
		return nil, limit, false
	}
	if ok, wait := g.ips.Allow(g.clientIP(r)); !ok {
		g.rateLimited(w, r, pid, signal, "client", wait)
		return nil, limit, false
	}
	return p, limit, true
}

func (g *Gateway) rateLimited(w http.ResponseWriter, r *http.Request, pid, signal, scope string, wait time.Duration) {
	g.metrics.rejected(r.Context(), pid, signal, ReasonRate)
	secs := int64(wait / time.Second)
	if wait%time.Second != 0 || secs == 0 {
		secs++
	}
	w.Header().Set("Retry-After", strconv.FormatInt(secs, 10))
	writeError(w, http.StatusTooManyRequests, scope+" rate limit exceeded")
}

// clientIP is the connection peer, or the last X-Forwarded-For hop when
// OUO_TRUST_PROXY is set (the hop the trusted proxy appended).
func (g *Gateway) clientIP(r *http.Request) string {
	if g.trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			hops := strings.Split(xff, ",")
			if ip := strings.TrimSpace(hops[len(hops)-1]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// serveOTLP is checks 1 to 7 for the OTLP routes.
func (g *Gateway) serveOTLP(w http.ResponseWriter, r *http.Request, signal string) {
	ctx := r.Context()
	p, limit, ok := g.check(w, r, signal, func(p *project.Project) int64 {
		if p != nil && p.MaxBodyBytes > 0 {
			return p.MaxBodyBytes
		}
		return g.maxBody
	})
	if !ok {
		return
	}

	// 1 (again, for bodies without Content-Length) + decompression.
	body, status, msg := readBody(w, r, limit)
	if status != 0 {
		reason := ReasonDecode
		if status == http.StatusRequestEntityTooLarge {
			reason = ReasonSize
		}
		g.metrics.rejected(ctx, p.ID, signal, reason)
		writeError(w, status, msg)
		return
	}

	// 5. decode
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	ct = strings.ToLower(ct)
	req, err := decode(signal, ct, body)
	if err != nil {
		g.metrics.rejected(ctx, p.ID, signal, ReasonDecode)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// 6. stamp, 7. re-encode and forward
	stamp(req, p.ID)
	out, err := encode(req)
	if err != nil {
		g.metrics.rejected(ctx, p.ID, signal, ReasonDecode)
		writeError(w, http.StatusBadRequest, "re-encode: "+err.Error())
		return
	}
	resp, err := g.forward(ctx, signal, out)
	if err != nil {
		g.metrics.collectorError(ctx, p.ID, signal)
		slog.Warn("collector unreachable", "signal", signal, "project", p.ID, "error", err)
		writeError(w, http.StatusBadGateway, "collector unreachable")
		return
	}
	if ct == contentTypeJSON {
		// The collector answered in protobuf (we sent protobuf); give the
		// JSON client the same message in OTLP/JSON.
		if j, ok := responseToJSON(signal, resp.status, resp.contentType, resp.body); ok {
			resp.body, resp.contentType = j, contentTypeJSON
		}
	}
	if resp.status/100 == 2 {
		g.metrics.accepted(ctx, p.ID, signal, int64(len(body)))
	} else {
		g.metrics.collectorError(ctx, p.ID, signal)
		slog.Warn("collector rejected payload", "signal", signal, "project", p.ID, "status", resp.status, "body", truncate(resp.body, 300))
	}
	if resp.contentType != "" {
		w.Header().Set("Content-Type", resp.contentType)
	}
	if resp.retryAfter != "" {
		w.Header().Set("Retry-After", resp.retryAfter)
	}
	w.WriteHeader(resp.status)
	w.Write(resp.body)
}

// readBody reads at most limit bytes (413 beyond), inflating gzip bodies to
// at most limit decompressed bytes. It returns a non-zero status on failure.
func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, int, string) {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, http.StatusRequestEntityTooLarge, fmt.Sprintf("body larger than %d bytes", limit)
		}
		return nil, http.StatusBadRequest, "read body: " + err.Error()
	}
	switch enc := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))); enc {
	case "", "identity":
		return raw, 0, ""
	case "gzip", "x-gzip":
		gr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, http.StatusBadRequest, "invalid gzip body: " + err.Error()
		}
		body, err := io.ReadAll(io.LimitReader(gr, limit+1))
		if err != nil {
			return nil, http.StatusBadRequest, "invalid gzip body: " + err.Error()
		}
		if int64(len(body)) > limit {
			return nil, http.StatusRequestEntityTooLarge, fmt.Sprintf("decompressed body larger than %d bytes", limit)
		}
		return body, 0, ""
	default:
		return nil, http.StatusBadRequest, "unsupported content-encoding " + enc + " (use gzip or none)"
	}
}

// collectorResponse is what forward passes back from the collector.
type collectorResponse struct {
	status      int
	contentType string
	retryAfter  string
	body        []byte
}

// forward posts the protobuf payload to <collector>/v1/<signal> within the
// collector timeout and reads at most maxCollectorResponse bytes back.
func (g *Gateway) forward(ctx context.Context, signal string, body []byte) (collectorResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.collector+"/v1/"+signal, bytes.NewReader(body))
	if err != nil {
		return collectorResponse{}, err
	}
	req.Header.Set("Content-Type", contentTypeProtobuf)
	req.Header.Set("User-Agent", "ouo-rum-api")
	resp, err := g.client.Do(req)
	if err != nil {
		return collectorResponse{}, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxCollectorResponse))
	if err != nil {
		return collectorResponse{}, err
	}
	return collectorResponse{status: resp.StatusCode, contentType: resp.Header.Get("Content-Type"), retryAfter: resp.Header.Get("Retry-After"), body: b}, nil
}

// responseToJSON transcodes a protobuf collector response (an
// Export*ServiceResponse on success, a google.rpc.Status otherwise) into
// OTLP/JSON. An empty 2xx body becomes "{}".
func responseToJSON(signal string, status int, ct string, body []byte) ([]byte, bool) {
	mt, _, _ := mime.ParseMediaType(ct)
	if mt == contentTypeJSON {
		return body, true
	}
	if mt != "" && mt != contentTypeProtobuf && mt != "application/protobuf" {
		return nil, false
	}
	var msg proto.Message
	if status/100 == 2 {
		switch signal {
		case SignalTraces:
			msg = &coltrace.ExportTraceServiceResponse{}
		case SignalLogs:
			msg = &collogs.ExportLogsServiceResponse{}
		case SignalMetrics:
			msg = &colmetrics.ExportMetricsServiceResponse{}
		}
	} else {
		msg = &rpcstatus.Status{}
	}
	if msg == nil || proto.Unmarshal(body, msg) != nil {
		return nil, false
	}
	j, err := protojson.Marshal(msg)
	if err != nil {
		return nil, false
	}
	return j, true
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// metrics are the ADR-0007 ingest counters.
type metrics struct {
	requests     metric.Int64Counter
	bytes        metric.Int64Counter
	replayChunks metric.Int64Counter
	replayBytes  metric.Int64Counter
}

func newMetrics(m metric.Meter) (metrics, error) {
	var (
		mm  metrics
		err error
	)
	if mm.requests, err = m.Int64Counter("ouo.ingest.requests", metric.WithDescription("Ingest requests by project, signal, outcome and rejection reason"), metric.WithUnit("{request}")); err != nil {
		return mm, err
	}
	if mm.bytes, err = m.Int64Counter("ouo.ingest.bytes", metric.WithDescription("Decompressed bytes accepted by project and signal"), metric.WithUnit("By")); err != nil {
		return mm, err
	}
	if mm.replayChunks, err = m.Int64Counter("ouo.replay.chunks", metric.WithDescription("Replay chunks stored by project"), metric.WithUnit("{chunk}")); err != nil {
		return mm, err
	}
	if mm.replayBytes, err = m.Int64Counter("ouo.replay.bytes", metric.WithDescription("Decompressed replay bytes stored by project"), metric.WithUnit("By")); err != nil {
		return mm, err
	}
	return mm, nil
}

func (m metrics) accepted(ctx context.Context, pid, signal string, n int64) {
	attrs := []attribute.KeyValue{attribute.String(ProjectIDAttribute, pid), attribute.String("signal", signal)}
	m.requests.Add(ctx, 1, metric.WithAttributes(append(attrs, attribute.String("outcome", OutcomeOK))...))
	m.bytes.Add(ctx, n, metric.WithAttributes(attrs...))
	if signal == SignalReplay {
		pa := metric.WithAttributes(attribute.String(ProjectIDAttribute, pid))
		m.replayChunks.Add(ctx, 1, pa)
		m.replayBytes.Add(ctx, n, pa)
	}
}

func (m metrics) rejected(ctx context.Context, pid, signal, reason string) {
	m.requests.Add(ctx, 1, metric.WithAttributes(
		attribute.String(ProjectIDAttribute, pid), attribute.String("signal", signal),
		attribute.String("outcome", OutcomeRejected), attribute.String("reason", reason)))
}

func (m metrics) collectorError(ctx context.Context, pid, signal string) {
	m.requests.Add(ctx, 1, metric.WithAttributes(
		attribute.String(ProjectIDAttribute, pid), attribute.String("signal", signal),
		attribute.String("outcome", OutcomeError), attribute.String("reason", ReasonCollector)))
}
