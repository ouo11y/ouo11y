package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componentstatus"
	"go.opentelemetry.io/collector/config/confighttp"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/receiver"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.uber.org/zap"

	"github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver/internal/metadata"
)

// envelopePathRe is the only route: POST /api/{sentry project id}/envelope/.
var envelopePathRe = regexp.MustCompile(`^/api/([0-9]{1,20})/envelope/?$`)

// hopHeaders are connection-scoped (RFC 9110 section 7.6.1) and never forwarded.
var hopHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Connection": true, "Te": true,
	"Trailer": true, "Transfer-Encoding": true, "Upgrade": true,
	"Proxy-Authenticate": true, "Proxy-Authorization": true,
}

// project is a resolved project table row.
type project struct {
	ProjectConfig
	upstream *url.URL // nil when Upstream == "none"
}

// job is one accepted envelope waiting for translation.
type job struct {
	project    *project
	encoding   string
	body       []byte
	receivedAt time.Time
	clientAddr string
}

type sentryReceiver struct {
	cfg      *Config
	set      receiver.Settings
	projects map[string]*project // "<sentry project id>/<public key>"
	client   *http.Client

	mu         sync.Mutex
	nextLogs   consumer.Logs
	nextTraces consumer.Traces

	queue       chan job
	workers     sync.WaitGroup
	state       *sessionState
	pending     pendingReplays
	pendingLogs pendingLogs
	stopTick    chan struct{}
	tickWG      sync.WaitGroup

	envelopes   metric.Int64Counter
	upstreamDur metric.Float64Histogram
	items       metric.Int64Counter
	dropped     metric.Int64Counter

	startOnce, stopOnce sync.Once
	startErr            error
	server              *http.Server
	serveWG             sync.WaitGroup
	release             func()
	addr                net.Addr
	// onEnvelope, when set (tests), sees every parsed envelope before translation.
	onEnvelope func(job, *Envelope)
}

// pendingTick is how often held logs are retried and expired.
const pendingTick = 5 * time.Second

func newReceiver(set receiver.Settings, cfg *Config) (*sentryReceiver, error) {
	r := &sentryReceiver{cfg: cfg, set: set, projects: map[string]*project{}}
	for _, pc := range cfg.Projects {
		p := &project{ProjectConfig: pc}
		if pc.Upstream != UpstreamNone {
			u, err := url.Parse(pc.Upstream)
			if err != nil {
				return nil, err
			}
			u.Path = strings.TrimRight(u.Path, "/")
			p.upstream = u
		}
		for _, k := range pc.PublicKeys {
			r.projects[pc.SentryProjectID+"/"+k] = p
		}
	}
	timeout := cfg.UpstreamTimeout
	if timeout <= 0 {
		timeout = DefaultUpstreamTimeout
	}
	r.client = &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:   true,
			MaxIdleConns:        256,
			MaxIdleConnsPerHost: 64,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 10 * time.Second,
			// Never add Accept-Encoding nor transparently gunzip the
			// response: the SDK must get the upstream's bytes and headers.
			DisableCompression: true,
		},
		// Return upstream redirects to the SDK instead of following them.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	qs := cfg.TranslateQueueSize
	if qs <= 0 {
		qs = DefaultTranslateQueueSize
	}
	r.queue = make(chan job, qs)
	r.state = newSessionState(cfg.State)

	meter := set.MeterProvider.Meter(metadata.ScopeName)
	var err error
	if r.envelopes, err = meter.Int64Counter("ouo_sentry_envelopes_total",
		metric.WithDescription("Envelope requests by ouo project and outcome (forwarded, rejected, upstream_error, accepted_local)."),
		metric.WithUnit("{envelope}")); err != nil {
		return nil, err
	}
	if r.upstreamDur, err = meter.Float64Histogram("ouo_sentry_upstream_duration_seconds",
		metric.WithDescription("Time from receiving the request to the upstream Sentry response headers."),
		metric.WithUnit("s")); err != nil {
		return nil, err
	}
	if r.items, err = meter.Int64Counter("ouo_sentry_items_total",
		metric.WithDescription("Envelope items seen by the translator, by type and whether they were translated."),
		metric.WithUnit("{item}")); err != nil {
		return nil, err
	}
	if r.dropped, err = meter.Int64Counter("ouo_sentry_translate_dropped_total",
		metric.WithDescription("Envelopes or items the translator dropped, by reason."),
		metric.WithUnit("{envelope}")); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *sentryReceiver) setLogs(next consumer.Logs) {
	r.mu.Lock()
	r.nextLogs = next
	r.mu.Unlock()
}

func (r *sentryReceiver) setTraces(next consumer.Traces) {
	r.mu.Lock()
	r.nextTraces = next
	r.mu.Unlock()
}

func (r *sentryReceiver) consumers() (consumer.Logs, consumer.Traces) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.nextLogs, r.nextTraces
}

// Start implements component.Component. The collector calls it once per
// pipeline signal; only the first call starts the server.
func (r *sentryReceiver) Start(ctx context.Context, host component.Host) error {
	r.startOnce.Do(func() { r.startErr = r.start(ctx, host) })
	return r.startErr
}

func (r *sentryReceiver) start(ctx context.Context, host component.Host) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", r.handle)

	sc := r.cfg.ServerConfig
	if len(sc.CompressionAlgorithms) > 0 {
		r.set.Logger.Warn("compression_algorithms is ignored: the Sentry bridge forwards raw request bytes and decompresses only its own copy")
	}
	// A non-nil empty list disables confighttp's decompressor, so the handler
	// sees the body exactly as the SDK sent it (compression.go: no decoders
	// means r.Body is not replaced).
	sc.CompressionAlgorithms = []string{}
	srv, err := sc.ToServer(ctx, host.GetExtensions(), r.set.TelemetrySettings, mux,
		// Middleware errors (body too large) in Sentry's JSON shape.
		withSentryErrorHandler())
	if err != nil {
		return err
	}
	r.server = srv
	ln, err := sc.ToListener(ctx)
	if err != nil {
		return err
	}
	r.addr = ln.Addr()
	r.set.Logger.Info("Starting Sentry bridge HTTP server", zap.String("endpoint", ln.Addr().String()), zap.Int("projects", len(r.cfg.Projects)))

	workers := 4
	for range workers {
		r.workers.Go(r.work)
	}
	// Held logs expire on a clock, not only when the next envelope arrives.
	r.stopTick = make(chan struct{})
	r.tickWG.Go(func() {
		t := time.NewTicker(pendingTick)
		defer t.Stop()
		for {
			select {
			case <-r.stopTick:
				return
			case <-t.C:
				r.flushPendingLogs(context.Background(), false)
			}
		}
	})
	r.serveWG.Go(func() {
		if errHTTP := r.server.Serve(ln); errHTTP != nil && !errors.Is(errHTTP, http.ErrServerClosed) {
			componentstatus.ReportStatus(host, componentstatus.NewFatalErrorEvent(errHTTP))
		}
	})
	return nil
}

// Shutdown implements component.Component. Pending translations are drained
// until ctx expires.
func (r *sentryReceiver) Shutdown(ctx context.Context) error {
	var err error
	r.stopOnce.Do(func() {
		if r.server != nil {
			err = r.server.Shutdown(ctx)
			r.serveWG.Wait()
			close(r.queue)
			done := make(chan struct{})
			go func() { r.workers.Wait(); close(done) }()
			select {
			case <-done:
			case <-ctx.Done():
			}
			close(r.stopTick)
			r.tickWG.Wait()
			// Logs still waiting for a session go out without one.
			r.flushPendingLogs(context.Background(), true)
		}
		if r.release != nil {
			r.release()
		}
	})
	return err
}

// handle serves POST /api/{id}/envelope/. Every other request is 404 or 405.
func (r *sentryReceiver) handle(w http.ResponseWriter, req *http.Request) {
	m := envelopePathRe.FindStringSubmatch(req.URL.Path)
	if m == nil {
		writeDetail(w, http.StatusNotFound, "not found: the Sentry bridge serves only POST /api/{project_id}/envelope/")
		return
	}
	if req.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeDetail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ctx := req.Context()
	start := time.Now()
	sentryID := m[1]

	body, err := io.ReadAll(req.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			r.count(ctx, "", "rejected", "size", 0)
			writeDetail(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("envelope larger than %d bytes", mbe.Limit))
			return
		}
		// The client went away mid-upload; nothing to answer.
		r.count(ctx, "", "rejected", "read", 0)
		return
	}

	key, err := r.publicKey(req, body)
	if err != nil {
		r.count(ctx, "", "rejected", "auth", 0)
		writeDetail(w, http.StatusForbidden, err.Error())
		return
	}
	p := r.projects[sentryID+"/"+key]
	if p == nil {
		// Never forward unknown projects or keys: the bridge is not an open proxy.
		r.count(ctx, "", "rejected", "auth", 0)
		writeDetail(w, http.StatusForbidden, "unknown project or public key")
		return
	}

	if p.upstream == nil {
		r.answerLocally(w, req, p, body, start)
		return
	}
	r.forward(w, req, p, body, start)
}

// publicKey finds the DSN public key in X-Sentry-Auth, the query string or,
// when neither is present, the envelope header `dsn`.
func (r *sentryReceiver) publicKey(req *http.Request, body []byte) (string, error) {
	hk, qk := requestKeys(req)
	switch {
	case hk != "" && qk != "" && hk != qk:
		return "", errors.New("conflicting sentry_key in X-Sentry-Auth and query string")
	case hk != "":
		return hk, nil
	case qk != "":
		return qk, nil
	}
	plain, err := Decompress(body, req.Header.Get("Content-Encoding"), r.translateLimit())
	if err != nil {
		return "", errors.New("missing authentication: no X-Sentry-Auth, sentry_key or readable envelope dsn")
	}
	line, _, _ := bytes.Cut(plain, []byte("\n"))
	var hdr struct {
		DSN string `json:"dsn"`
	}
	if json.Unmarshal(line, &hdr) == nil {
		if k := keyFromDSN(hdr.DSN); k != "" {
			return k, nil
		}
	}
	return "", errors.New("missing authentication: no X-Sentry-Auth, sentry_key or envelope dsn")
}

// forward sends the request to the upstream unchanged and copies the answer
// back unchanged. If the upstream cannot be reached the client connection is
// aborted, which the SDK treats exactly like Sentry being unreachable (it
// keeps the envelope and retries), instead of a 5xx it might discard on.
func (r *sentryReceiver) forward(w http.ResponseWriter, req *http.Request, p *project, body []byte, start time.Time) {
	ctx := req.Context()
	target := *p.upstream
	target.Path = p.upstream.Path + req.URL.Path
	target.RawPath = ""
	target.RawQuery = req.URL.RawQuery

	out, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		r.count(ctx, p.OuoProjectID, "upstream_error", "request", 0)
		panic(http.ErrAbortHandler)
	}
	for k, vs := range req.Header {
		if !hopHeaders[k] && k != "X-Forwarded-For" {
			out.Header[k] = append([]string(nil), vs...)
		}
	}
	// Sentry derives the user's IP from X-Forwarded-For when a proxy or
	// tunnel sits in front (else every event would carry the bridge's IP).
	if ip := clientIP(req.RemoteAddr); ip != "" {
		if prior := req.Header.Values("X-Forwarded-For"); len(prior) > 0 {
			out.Header.Set("X-Forwarded-For", strings.Join(prior, ", ")+", "+ip)
		} else {
			out.Header.Set("X-Forwarded-For", ip)
		}
	}
	out.ContentLength = int64(len(body))

	resp, err := r.client.Do(out)
	r.upstreamDur.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("ouo.project.id", p.OuoProjectID)))
	if err != nil {
		r.count(ctx, p.OuoProjectID, "upstream_error", "unreachable", 0)
		r.set.Logger.Warn("Sentry upstream unreachable; aborting the client connection so the SDK retries",
			zap.String("upstream", p.upstream.Host), zap.Error(err))
		panic(http.ErrAbortHandler)
	}
	defer resp.Body.Close()

	for k, vs := range resp.Header {
		if !hopHeaders[k] {
			w.Header()[k] = append([]string(nil), vs...)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, copyErr := io.Copy(w, resp.Body)

	r.count(ctx, p.OuoProjectID, "forwarded", "", resp.StatusCode)
	if copyErr != nil {
		r.set.Logger.Debug("copying the upstream response to the SDK failed", zap.Error(copyErr))
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		r.enqueue(ctx, p, req, body, start)
	}
}

// answerLocally is the cutover mode (`upstream: none`): answer like Sentry.
func (r *sentryReceiver) answerLocally(w http.ResponseWriter, req *http.Request, p *project, body []byte, start time.Time) {
	id := ""
	if plain, err := Decompress(body, req.Header.Get("Content-Encoding"), r.translateLimit()); err == nil {
		line, _, _ := bytes.Cut(plain, []byte("\n"))
		var hdr struct {
			EventID string `json:"event_id"`
		}
		if json.Unmarshal(line, &hdr) == nil {
			id = hdr.EventID
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"id": id})
	r.count(req.Context(), p.OuoProjectID, "accepted_local", "", http.StatusOK)
	r.enqueue(req.Context(), p, req, body, start)
}

func (r *sentryReceiver) translateLimit() int64 {
	if r.cfg.MaxTranslateBytes > 0 {
		return r.cfg.MaxTranslateBytes
	}
	return DefaultMaxTranslateBytes
}

// enqueue hands the envelope to the translator without ever blocking the request.
func (r *sentryReceiver) enqueue(ctx context.Context, p *project, req *http.Request, body []byte, start time.Time) {
	if int64(len(body)) > r.translateLimit() {
		r.drop(ctx, p.OuoProjectID, "too_large")
		return
	}
	j := job{project: p, encoding: req.Header.Get("Content-Encoding"), body: body, receivedAt: start, clientAddr: clientIP(req.RemoteAddr)}
	select {
	case r.queue <- j:
	default:
		r.drop(ctx, p.OuoProjectID, "queue_full")
	}
}

func (r *sentryReceiver) work() {
	for j := range r.queue {
		r.process(j)
	}
}

// process decodes one envelope and translates it (translate.go).
func (r *sentryReceiver) process(j job) {
	ctx := context.Background()
	plain, err := Decompress(j.body, j.encoding, r.translateLimit())
	if err != nil {
		r.drop(ctx, j.project.OuoProjectID, "encoding")
		r.set.Logger.Debug("envelope not translated: cannot decompress", zap.Error(err))
		return
	}
	env, err := ParseEnvelope(plain)
	if err != nil {
		r.drop(ctx, j.project.OuoProjectID, "malformed")
		r.set.Logger.Debug("envelope not translated: malformed", zap.Error(err))
		return
	}
	if r.onEnvelope != nil {
		r.onEnvelope(j, env)
	}
	r.translate(ctx, j, env)
}

func (r *sentryReceiver) count(ctx context.Context, projectID, outcome, reason string, status int) {
	attrs := []attribute.KeyValue{attribute.String("ouo.project.id", projectID), attribute.String("outcome", outcome)}
	if reason != "" {
		attrs = append(attrs, attribute.String("reason", reason))
	}
	if status != 0 {
		attrs = append(attrs, attribute.String("status_code", strconv.Itoa(status)))
	}
	r.envelopes.Add(ctx, 1, metric.WithAttributes(attrs...))
}

func (r *sentryReceiver) drop(ctx context.Context, projectID, reason string) {
	r.dropped.Add(ctx, 1, metric.WithAttributes(attribute.String("ouo.project.id", projectID), attribute.String("reason", reason)))
}

func clientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

func writeDetail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"detail": msg})
}

func withSentryErrorHandler() confighttp.ToServerOption {
	return confighttp.WithErrorHandler(func(w http.ResponseWriter, _ *http.Request, msg string, code int) {
		writeDetail(w, code, msg)
	})
}
