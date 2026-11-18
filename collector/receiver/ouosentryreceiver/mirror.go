package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"bufio"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.uber.org/zap"
)

// Mirrors (spec section 2b, ADR-0028): every envelope the bridge answered is
// also sent, asynchronously, to each mirror of its project. The SDK's answer
// is the primary's; the hot path only does an atomic budget take and a
// non-blocking channel send. The bound is the bytes waiting for all mirrors
// together; whatever does not fit is dropped and counted.

const (
	// mirrorWorkers is the number of concurrent sends per mirror.
	mirrorWorkers = 4
	// mirrorQueueLen only sizes the channel; queue_bytes is the real bound.
	mirrorQueueLen = 10000
	// dsnLineMax bounds the envelope header line read to find a dsn.
	dsnLineMax = 64 << 10
)

// byteBudget is a lock-free byte bound shared by the producers of a queue.
type byteBudget struct {
	used  atomic.Int64
	limit int64
}

func (b *byteBudget) take(n int64) bool {
	if b.used.Add(n) > b.limit {
		b.used.Add(-n)
		return false
	}
	return true
}

func (b *byteBudget) give(n int64) { b.used.Add(-n) }

// mirror is one resolved MirrorConfig of one project.
type mirror struct {
	name      string
	project   string // ouo_project_id, labels the metrics with name
	base      *url.URL
	projectID string // "" = unchanged
	publicKey string // "" = unchanged
	queue     chan mirrorJob
}

// mirrorJob is one answered envelope request waiting for a mirror.
type mirrorJob struct {
	sentryID string // project id of the original request
	key      string // public key the original request authenticated with
	path     string
	rawQuery string
	header   http.Header // already cloned, X-Forwarded-For set
	body     []byte      // shared with the translation job: read only
}

// mirrorSet holds every mirror, their client and budget.
type mirrorSet struct {
	all    []*mirror
	client *http.Client
	budget *byteBudget
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func newMirrorSet(s MirrorSettings) *mirrorSet {
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = DefaultMirrorTimeout
	}
	limit := s.QueueBytes
	if limit <= 0 {
		limit = DefaultMirrorQueueBytes
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &mirrorSet{
		client: &http.Client{
			Timeout: timeout,
			// Its own pool: a hanging mirror never holds a primary connection.
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				ForceAttemptHTTP2:     true,
				MaxIdleConns:          64,
				MaxIdleConnsPerHost:   mirrorWorkers,
				IdleConnTimeout:       90 * time.Second,
				TLSHandshakeTimeout:   5 * time.Second,
				ResponseHeaderTimeout: timeout,
				DisableCompression:    true,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		budget: &byteBudget{limit: limit},
		ctx:    ctx,
		cancel: cancel,
	}
}

func (ms *mirrorSet) add(mc MirrorConfig, ouoProjectID string) (*mirror, error) {
	u, err := url.Parse(mc.Upstream)
	if err != nil {
		return nil, err
	}
	u.Path = strings.TrimRight(u.Path, "/")
	m := &mirror{name: mirrorName(mc), project: ouoProjectID, base: u, projectID: mc.SentryProjectID, publicKey: mc.PublicKey, queue: make(chan mirrorJob, mirrorQueueLen)}
	ms.all = append(ms.all, m)
	return m, nil
}

// start runs the workers of every mirror.
func (r *sentryReceiver) startMirrors() {
	for _, m := range r.mirrors.all {
		for range mirrorWorkers {
			r.mirrors.wg.Go(func() {
				for j := range m.queue {
					r.sendMirror(m, j)
					r.mirrors.budget.give(int64(len(j.body)))
				}
			})
		}
	}
}

// stopMirrors lets the workers drain the queues closeQueues closed until
// ctx expires, then aborts what is still in flight.
func (r *sentryReceiver) stopMirrors(ctx context.Context) {
	ms := r.mirrors
	done := make(chan struct{})
	go func() { ms.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		ms.cancel()
		<-done
	}
	ms.cancel()
}

// mirrorEnvelope queues a copy of an answered envelope for each mirror of p.
// It never blocks: a full queue or budget drops the copy.
func (r *sentryReceiver) mirrorEnvelope(ctx context.Context, p *project, req *http.Request, sentryID, key string, header http.Header, body []byte) {
	if len(p.mirrors) == 0 {
		return
	}
	ms := r.mirrors
	r.closing.RLock()
	defer r.closing.RUnlock()
	for _, m := range p.mirrors {
		if r.closed {
			r.mirrorCount(ctx, m, "dropped", "shutdown", 0)
			continue
		}
		if !ms.budget.take(int64(len(body))) {
			r.mirrorCount(ctx, m, "dropped", "queue_bytes", 0)
			continue
		}
		j := mirrorJob{sentryID: sentryID, key: key, path: req.URL.Path, rawQuery: req.URL.RawQuery, header: header, body: body}
		select {
		case m.queue <- j:
		default:
			ms.budget.give(int64(len(body)))
			r.mirrorCount(ctx, m, "dropped", "queue_full", 0)
		}
	}
}

// sendMirror sends one copy. Failures are counted, never retried: the mirror
// is a preview, the primary already has the envelope.
func (r *sentryReceiver) sendMirror(m *mirror, j mirrorJob) {
	ctx := context.Background()
	defer func() {
		if v := recover(); v != nil {
			r.mirrorCount(ctx, m, "error", "panic", 0)
			r.set.Logger.Error("mirror send panicked", zap.String("mirror", m.name), zap.Any("panic", v))
		}
	}()
	start := time.Now()
	out, rewrote, err := m.request(r.mirrors.ctx, j, r.translateLimit())
	if err != nil {
		r.mirrorCount(ctx, m, "error", "request", 0)
		return
	}
	// A copy whose dsn could not be checked is sent as received; its send
	// outcome carries the reason, so each copy is counted once.
	note := ""
	if rewrote == rewriteSkipped {
		note = "body_not_rewritten"
		r.set.Logger.Debug("mirror copy sent without dsn rewrite", zap.String("mirror", m.name), zap.String("encoding", j.header.Get("Content-Encoding")))
	}
	resp, err := r.mirrors.client.Do(out)
	r.mirrorDur.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("mirror", m.name), attribute.String("ouo.project.id", m.project)))
	if err != nil {
		reason := "unreachable"
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			reason = "timeout"
		}
		r.mirrorCount(ctx, m, "error", reason, 0)
		r.set.Logger.Debug("mirror send failed", zap.String("mirror", m.name), zap.Error(err))
		return
	}
	// Drain a bounded amount so the connection is reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	r.mirrorCount(ctx, m, "sent", note, resp.StatusCode)
}

type rewriteResult int

const (
	rewriteNone    rewriteResult = iota // body sent as received
	rewriteDone                         // envelope header dsn rewritten
	rewriteSkipped                      // dsn could not be checked (encoding, corrupt, header line too long): body sent as received
)

// request builds the mirror request: same method, body and headers; project
// id and public key replaced where the mirror sets them (spec section 2b).
func (m *mirror) request(ctx context.Context, j mirrorJob, limit int64) (*http.Request, rewriteResult, error) {
	projectID := firstString(m.projectID, j.sentryID)
	key := firstString(m.publicKey, j.key)
	changeKey := key != j.key
	path := j.path
	if projectID != j.sentryID {
		path = strings.Replace(path, "/api/"+j.sentryID+"/", "/api/"+projectID+"/", 1)
	}
	target := *m.base
	target.Path = m.base.Path + path
	target.RawPath = ""
	target.RawQuery = j.rawQuery
	header := j.header
	body := j.body
	res := rewriteNone
	if changeKey || projectID != j.sentryID {
		header = j.header.Clone()
		if changeKey {
			target.RawQuery = rewriteQueryKey(j.rawQuery, key)
			for _, h := range []string{"X-Sentry-Auth", "Authorization"} {
				if vs := header.Values(h); len(vs) > 0 {
					for i, v := range vs {
						vs[i] = rewriteAuthKey(v, key)
					}
				}
			}
		}
		dsn := fmt.Sprintf("%s://%s@%s%s/%s", m.base.Scheme, key, m.base.Host, m.base.Path, projectID)
		nb, changed, err := rewriteEnvelopeDSN(body, header.Get("Content-Encoding"), dsn, limit)
		switch {
		case err != nil:
			res = rewriteSkipped
		case changed:
			body, res = nb, rewriteDone
		}
	}
	out, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, res, err
	}
	out.Header = header
	out.ContentLength = int64(len(body))
	return out, res, nil
}

// rewriteAuthKey replaces sentry_key in a `Sentry k=v, ...` value and drops
// the deprecated sentry_secret (it belongs to the primary).
func rewriteAuthKey(v, key string) string {
	t := strings.TrimLeft(v, " ")
	if len(t) < 7 || !strings.EqualFold(t[:6], "Sentry") {
		return v
	}
	parts := strings.Split(t[6:], ",")
	out := parts[:0]
	for _, part := range parts {
		k, _, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch strings.TrimSpace(k) {
		case "sentry_secret":
			continue
		case "sentry_key":
			lead := part[:len(part)-len(strings.TrimLeft(part, " "))]
			part = lead + "sentry_key=" + key
		}
		out = append(out, part)
	}
	return t[:6] + strings.Join(out, ",")
}

// rewriteQueryKey replaces sentry_key and drops sentry_secret, keeping the
// other parameters byte for byte and in order.
func rewriteQueryKey(raw, key string) string {
	if raw == "" {
		return raw
	}
	parts := strings.Split(raw, "&")
	out := parts[:0]
	for _, p := range parts {
		switch {
		case strings.HasPrefix(p, "sentry_secret="):
			continue
		case strings.HasPrefix(p, "sentry_key="):
			p = "sentry_key=" + url.QueryEscape(key)
		}
		out = append(out, p)
	}
	return strings.Join(out, "&")
}

// rewriteEnvelopeDSN replaces the envelope header's `dsn` when it has one.
// Only the header line (at most dsnLineMax bytes) is decoded to look; bodies
// without a dsn (every mobile SDK observed) come back unchanged. A rewritten
// body is streamed through a new encoder of the same Content-Encoding; a
// decoded body over limit (max_translate_bytes, a compression bomb) is an
// error, so the copy goes out as received.
func rewriteEnvelopeDSN(body []byte, encoding, dsn string, limit int64) ([]byte, bool, error) {
	dec, rawDeflate, err := newDecoder(body, encoding)
	if err != nil {
		return nil, false, err
	}
	var src io.Reader = bytes.NewReader(body)
	if dec != nil {
		defer dec.Close()
		src = dec
	}
	br := bufio.NewReaderSize(io.LimitReader(src, limit+1), 4096)
	line, hasRest, err := readLine(br, dsnLineMax)
	if err != nil {
		return nil, false, err
	}
	if !bytes.Contains(line, []byte(`"dsn"`)) {
		return body, false, nil
	}
	var hdr map[string]json.RawMessage
	if err := json.Unmarshal(line, &hdr); err != nil {
		return body, false, nil // malformed: forward as is, upstream decides
	}
	if _, ok := hdr["dsn"]; !ok {
		return body, false, nil
	}
	hdr["dsn"], _ = json.Marshal(dsn)
	nl, err := json.Marshal(hdr)
	if err != nil {
		return nil, false, err
	}
	var out bytes.Buffer
	out.Grow(len(body) + len(nl) - len(line))
	var enc io.WriteCloser
	switch {
	case dec == nil:
	case rawDeflate:
		enc, _ = flate.NewWriter(&out, flate.DefaultCompression)
	case strings.EqualFold(strings.TrimSpace(encoding), "deflate"):
		enc = zlib.NewWriter(&out)
	default:
		enc = gzip.NewWriter(&out)
	}
	var w io.Writer = &out
	if enc != nil {
		w = enc
	}
	_, _ = w.Write(nl)
	if hasRest {
		_, _ = w.Write([]byte{'\n'})
		n, err := io.Copy(w, br)
		if err != nil {
			return nil, false, err
		}
		if int64(len(line))+1+n > limit {
			return nil, false, fmt.Errorf("decoded envelope larger than %d bytes", limit)
		}
	}
	if enc != nil {
		if err := enc.Close(); err != nil {
			return nil, false, err
		}
	}
	return out.Bytes(), true, nil
}

// readLine reads up to the first newline (not included), at most limit bytes.
// hasRest reports that a newline was found.
func readLine(br *bufio.Reader, limit int) (line []byte, hasRest bool, err error) {
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > limit+1 {
			return nil, false, fmt.Errorf("envelope header line longer than %d bytes", limit)
		}
		switch {
		case err == nil:
			return line[:len(line)-1], true, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			return line, false, nil
		default:
			return nil, false, err
		}
	}
}

func (r *sentryReceiver) mirrorCount(ctx context.Context, m *mirror, outcome, reason string, status int) {
	attrs := []attribute.KeyValue{attribute.String("mirror", m.name), attribute.String("ouo.project.id", m.project), attribute.String("outcome", outcome)}
	if reason != "" {
		attrs = append(attrs, attribute.String("reason", reason))
	}
	if status != 0 {
		attrs = append(attrs, attribute.String("status_code", strconv.Itoa(status)))
	}
	r.mirrorReqs.Add(ctx, 1, metric.WithAttributes(attrs...))
}
