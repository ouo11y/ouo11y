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

	"go.opentelemetry.io/collector/client"
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

// ingestPathRe matches Sentry's ingest routes, /api/{sentry project id}/{endpoint}/.
// Only `envelope` is translated and mirrored; the others (store, minidump,
// security, unreal, ...) are forwarded unchanged (spec section 2a).
var ingestPathRe = regexp.MustCompile(`^/api/([0-9]{1,20})/([a-z][a-z_-]{0,31})/?$`)

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
	mirrors  []*mirror
}

// job is one accepted envelope waiting for translation.
type job struct {
	project    *project
	encoding   string
	body       []byte
	receivedAt time.Time
	clientAddr string
	// forwardedFor is the request's X-Forwarded-For, handed down as client
	// metadata so ouoratelimit's `key_from: x_forwarded_for` can tell the
	// devices behind a proxy apart.
	forwardedFor []string
	// origin identifies the sending device's network path (X-Forwarded-For
	// chain and peer address) for the startup log rule; never trusted for
	// anything else.
	origin string
}

// clientInfo is the client context the job's telemetry enters the pipelines
// with: the ouo project as auth (like basicauth), the peer address and the
// X-Forwarded-For header as metadata (like include_metadata: true).
func (j job) clientInfo() client.Info {
	info := client.Info{Auth: projectAuth(j.project.OuoProjectID)}
	if ip := net.ParseIP(j.clientAddr); ip != nil {
		info.Addr = &net.IPAddr{IP: ip}
	}
	if len(j.forwardedFor) > 0 {
		info.Metadata = client.NewMetadata(map[string][]string{"X-Forwarded-For": j.forwardedFor})
	}
	return info
}

// originKey is the job's origin, or its client address without one.
func (j job) originKey() string {
	return firstString(j.origin, j.clientAddr)
}

func requestOrigin(req *http.Request) string {
	return strings.Join(append(req.Header.Values("X-Forwarded-For"), clientIP(req.RemoteAddr)), ",")
}

type sentryReceiver struct {
	cfg      *Config
	set      receiver.Settings
	projects map[string]*project // "<sentry project id>/<public key>"
	client   *http.Client
	// passthrough receives what the project table does not match (nil: 403/404).
	passthrough *url.URL
	mirrors     *mirrorSet
	// translateBudget bounds the bytes waiting in queue.
	translateBudget *byteBudget

	mu         sync.Mutex
	nextLogs   consumer.Logs
	nextTraces consumer.Traces

	queue chan job
	// closing guards the translate and mirror queues against a send after
	// Shutdown closed them (a handler still waiting on its upstream).
	closing     sync.RWMutex
	closed      bool
	workers     sync.WaitGroup
	state       *sessionState
	pending     pendingReplays
	webReplays  webReplays
	pendingLogs pendingLogs
	stopTick    chan struct{}
	tickWG      sync.WaitGroup

	envelopes   metric.Int64Counter
	upstreamDur metric.Float64Histogram
	items       metric.Int64Counter
	dropped     metric.Int64Counter
	mirrorReqs  metric.Int64Counter
	mirrorDur   metric.Float64Histogram

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
	r := &sentryReceiver{cfg: cfg, set: set, projects: map[string]*project{}, mirrors: newMirrorSet(cfg.Mirror)}
	if cfg.PassthroughUpstream != "" {
		u, err := url.Parse(cfg.PassthroughUpstream)
		if err != nil {
			return nil, err
		}
		u.Path = strings.TrimRight(u.Path, "/")
		r.passthrough = u
	}
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
		for _, mc := range pc.Mirrors {
			m, err := r.mirrors.add(mc, pc.OuoProjectID)
			if err != nil {
				return nil, err
			}
			p.mirrors = append(p.mirrors, m)
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
	qb := cfg.TranslateQueueBytes
	if qb <= 0 {
		qb = DefaultTranslateQueueBytes
	}
	r.translateBudget = &byteBudget{limit: qb}
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
	if r.mirrorReqs, err = meter.Int64Counter("ouo_sentry_mirror_requests_total",
		metric.WithDescription("Envelope copies for mirror upstreams by mirror, ouo project and outcome (sent, error, dropped)."),
		metric.WithUnit("{envelope}")); err != nil {
		return nil, err
	}
	if r.mirrorDur, err = meter.Float64Histogram("ouo_sentry_mirror_duration_seconds",
		metric.WithDescription("Time of one mirror send, building the request to the response headers."),
		metric.WithUnit("s")); err != nil {
		return nil, err
	}
	if _, err = meter.Int64ObservableGauge("ouo_sentry_queue_bytes",
		metric.WithDescription("Bytes waiting in the translate and mirror queues."),
		metric.WithUnit("By"),
		metric.WithInt64Callback(func(_ context.Context, o metric.Int64Observer) error {
			o.Observe(r.translateBudget.used.Load(), metric.WithAttributes(attribute.String("queue", "translate")))
			o.Observe(r.mirrors.budget.used.Load(), metric.WithAttributes(attribute.String("queue", "mirror")))
			return nil
		})); err != nil {
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
	r.startMirrors()
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
			r.closeQueues()
			done := make(chan struct{})
			go func() { r.workers.Wait(); close(done) }()
			select {
			case <-done:
			case <-ctx.Done():
			}
			close(r.stopTick)
			r.tickWG.Wait()
			r.stopMirrors(ctx)
			// Logs still waiting for a session go out without one.
			r.flushPendingLogs(context.Background(), true)
		}
		if r.release != nil {
			r.release()
		}
	})
	return err
}

// closeQueues closes the translate and mirror queues; later sends drop.
func (r *sentryReceiver) closeQueues() {
	r.closing.Lock()
	defer r.closing.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	close(r.queue)
	for _, m := range r.mirrors.all {
		close(m.queue)
	}
}

// handle serves the ingest routes /api/{id}/{endpoint}/. Envelopes of a
// known project are forwarded, mirrored and translated; everything else the
// bridge does not serve (unknown key or project, other paths and methods)
// goes to passthrough_upstream when set, else 403 / 404 / 405.
func (r *sentryReceiver) handle(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()
	start := time.Now()
	m := ingestPathRe.FindStringSubmatch(req.URL.Path)
	envelopeNotPost := m != nil && m[2] == "envelope" && req.Method != http.MethodPost
	if r.passthrough == nil {
		switch {
		case m == nil:
			writeDetail(w, http.StatusNotFound, "not found: the Sentry bridge serves only /api/{project_id}/envelope/")
			return
		case envelopeNotPost:
			w.Header().Set("Allow", http.MethodPost)
			writeDetail(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
	}

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
	if m == nil || envelopeNotPost {
		r.forwardOther(w, req, r.passthrough, "", body, start)
		return
	}

	sentryID, endpoint := m[1], m[2]
	if endpoint != "envelope" {
		// Other ingest endpoints: forwarded unchanged, never translated.
		hk, qk := requestKeys(req)
		if p := r.projects[sentryID+"/"+firstString(hk, qk)]; p != nil && p.upstream != nil {
			r.forwardOther(w, req, p.upstream, p.OuoProjectID, body, start)
			return
		}
		if r.passthrough != nil {
			r.forwardOther(w, req, r.passthrough, "", body, start)
			return
		}
		writeDetail(w, http.StatusNotFound, "not found: the Sentry bridge serves only /api/{project_id}/envelope/")
		return
	}

	key, err := r.publicKey(req, body)
	var p *project
	if err == nil {
		p = r.projects[sentryID+"/"+key]
	}
	if p == nil {
		if r.passthrough != nil {
			r.forwardOther(w, req, r.passthrough, "", body, start)
			return
		}
		r.count(ctx, "", "rejected", "auth", 0)
		if err != nil {
			writeDetail(w, http.StatusForbidden, err.Error())
		} else {
			// Never forward unknown projects or keys without passthrough_upstream:
			// the bridge is not an open proxy.
			writeDetail(w, http.StatusForbidden, "unknown project or public key")
		}
		return
	}

	if p.upstream == nil {
		r.answerLocally(w, req, p, sentryID, key, body, start)
		return
	}
	r.forward(w, req, p, sentryID, key, body, start)
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

// forwardHeader is the request's header for an upstream: everything but the
// hop-by-hop headers, with the client address appended to X-Forwarded-For
// (Sentry derives the user's IP from it when a proxy sits in front).
func forwardHeader(req *http.Request) http.Header {
	h := make(http.Header, len(req.Header)+1)
	for k, vs := range req.Header {
		if !hopHeaders[k] && k != "X-Forwarded-For" {
			h[k] = append([]string(nil), vs...)
		}
	}
	if ip := clientIP(req.RemoteAddr); ip != "" {
		if prior := req.Header.Values("X-Forwarded-For"); len(prior) > 0 {
			h.Set("X-Forwarded-For", strings.Join(prior, ", ")+", "+ip)
		} else {
			h.Set("X-Forwarded-For", ip)
		}
	}
	return h
}

// proxy sends the request to base unchanged (same method, path, query, body
// and end-to-end headers) and copies the answer back unchanged. An error
// means nothing was written to w.
func (r *sentryReceiver) proxy(w http.ResponseWriter, req *http.Request, base *url.URL, header http.Header, body []byte) (int, error) {
	target := *base
	target.Path = base.Path + req.URL.Path
	target.RawPath = ""
	target.RawQuery = req.URL.RawQuery
	out, err := http.NewRequestWithContext(req.Context(), req.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	out.Header = header
	out.ContentLength = int64(len(body))
	resp, err := r.client.Do(out)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		if !hopHeaders[k] {
			w.Header()[k] = append([]string(nil), vs...)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		r.set.Logger.Debug("copying the upstream response to the SDK failed", zap.Error(err))
	}
	// The SDK has its answer before any copy or translation is queued.
	_ = http.NewResponseController(w).Flush()
	return resp.StatusCode, nil
}

// abort answers an unreachable upstream by aborting the client connection,
// which the SDK treats exactly like Sentry being unreachable (it keeps the
// envelope and retries), instead of a 5xx it might discard on.
func (r *sentryReceiver) abort(ctx context.Context, projectID string, upstream *url.URL, err error) {
	r.count(ctx, projectID, "upstream_error", "unreachable", 0)
	r.set.Logger.Warn("Sentry upstream unreachable; aborting the client connection so the SDK retries",
		zap.String("upstream", upstream.Host), zap.Error(err))
	panic(http.ErrAbortHandler)
}

// forward sends an envelope of a known project to its upstream, then queues
// the mirror copies (whatever the status) and, on 2xx, the translation.
func (r *sentryReceiver) forward(w http.ResponseWriter, req *http.Request, p *project, sentryID, key string, body []byte, start time.Time) {
	ctx := req.Context()
	header := forwardHeader(req)
	status, err := r.proxy(w, req, p.upstream, header, body)
	r.upstreamDur.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("ouo.project.id", p.OuoProjectID)))
	if err != nil {
		// No mirror copy either: the SDK retries, the mirror gets the retry.
		r.abort(ctx, p.OuoProjectID, p.upstream, err)
	}
	r.count(ctx, p.OuoProjectID, "forwarded", "", status)
	r.mirrorEnvelope(ctx, p, req, sentryID, key, header, body)
	if status >= 200 && status < 300 {
		r.enqueue(ctx, p, req, body, start)
	}
}

// forwardOther forwards a request the bridge does not translate: another
// ingest endpoint, or (to passthrough_upstream) one the table does not match.
func (r *sentryReceiver) forwardOther(w http.ResponseWriter, req *http.Request, upstream *url.URL, projectID string, body []byte, start time.Time) {
	ctx := req.Context()
	status, err := r.proxy(w, req, upstream, forwardHeader(req), body)
	r.upstreamDur.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("ouo.project.id", projectID)))
	if err != nil {
		r.abort(ctx, projectID, upstream, err)
	}
	r.count(ctx, projectID, "passthrough", "", status)
}

// answerLocally is the cutover mode (`upstream: none`): answer like Sentry.
func (r *sentryReceiver) answerLocally(w http.ResponseWriter, req *http.Request, p *project, sentryID, key string, body []byte, start time.Time) {
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
	_ = http.NewResponseController(w).Flush()
	r.count(req.Context(), p.OuoProjectID, "accepted_local", "", http.StatusOK)
	r.mirrorEnvelope(req.Context(), p, req, sentryID, key, forwardHeader(req), body)
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
	r.closing.RLock()
	defer r.closing.RUnlock()
	if r.closed {
		r.drop(ctx, p.OuoProjectID, "shutdown")
		return
	}
	if !r.translateBudget.take(int64(len(body))) {
		r.drop(ctx, p.OuoProjectID, "queue_bytes")
		return
	}
	j := job{project: p, encoding: req.Header.Get("Content-Encoding"), body: body, receivedAt: start, clientAddr: clientIP(req.RemoteAddr), forwardedFor: req.Header.Values("X-Forwarded-For"), origin: requestOrigin(req)}
	select {
	case r.queue <- j:
	default:
		r.translateBudget.give(int64(len(body)))
		r.drop(ctx, p.OuoProjectID, "queue_full")
	}
}

func (r *sentryReceiver) work() {
	for j := range r.queue {
		r.processSafe(j)
		r.translateBudget.give(int64(len(j.body)))
	}
}

// processSafe translates one envelope; a translator panic drops that envelope
// instead of taking the collector, and with it the forwarding, down.
func (r *sentryReceiver) processSafe(j job) {
	defer func() {
		if v := recover(); v != nil {
			r.drop(context.Background(), j.project.OuoProjectID, "panic")
			r.set.Logger.Error("translator panicked; envelope dropped (it was forwarded)", zap.Any("panic", v), zap.Stack("stack"))
		}
	}()
	r.process(j)
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
