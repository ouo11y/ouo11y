package ouosentryreceiver

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

const previewKey = "fedcba9876543210fedcba9876543210"

// counter sums the data points of an Int64 counter whose attributes include want.
func (h *harness) counter(t *testing.T, name string, want ...attribute.KeyValue) int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := h.metrics.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	var n int64
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != name {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				continue
			}
		points:
			for _, dp := range sum.DataPoints {
				for _, kv := range want {
					if v, ok := dp.Attributes.Value(kv.Key); !ok || v != kv.Value {
						continue points
					}
				}
				n += dp.Value
			}
		}
	}
	return n
}

// waitCounter polls a counter until it reaches n (mirror sends are asynchronous).
func (h *harness) waitCounter(t *testing.T, n int64, name string, want ...attribute.KeyValue) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := h.counter(t, name, want...)
		if got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s%v = %d, want %d", name, want, got, n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func withMirrors(ms ...MirrorConfig) func(*Config) {
	return func(c *Config) { c.Projects[0].Mirrors = ms }
}

func (f *fakeUpstream) waitRequests(t *testing.T, n int) []seenRequest {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if r := f.requests(); len(r) >= n {
			return r
		}
		if time.Now().After(deadline) {
			t.Fatalf("upstream saw %d requests, want %d", len(f.requests()), n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestMirrorGetsIdenticalCopy(t *testing.T) {
	prod, preview := newFakeUpstream(t), newFakeUpstream(t)
	preview.reply = func(w http.ResponseWriter) {
		w.Header().Set("X-Sentry-Rate-Limits", "60::organization")
		w.WriteHeader(429)
	}
	h := startReceiver(t, prod.URL, withMirrors(MirrorConfig{Name: "preview", Upstream: preview.URL}))
	body := gz(t, []byte(sampleEnvelope))
	resp := post(t, h.base+"/api/"+testProject+"/envelope/?sentry_version=7", body, sdkHeaders())
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	// The SDK sees prod's answer, never the mirror's 429.
	if resp.StatusCode != 200 || string(got) != `{"id":"9ec79c33ec9942ab8353589fcb2e04dc"}` || resp.Header.Get("X-Sentry-Rate-Limits") != "" {
		t.Fatalf("SDK got %d %s %v", resp.StatusCode, got, resp.Header)
	}
	p := prod.requests()[0]
	m := preview.waitRequests(t, 1)[0]
	if !bytes.Equal(m.body, body) || !bytes.Equal(p.body, body) {
		t.Errorf("bodies differ: sent %d, prod %d, mirror %d bytes", len(body), len(p.body), len(m.body))
	}
	if m.path != p.path || m.rawQuery != p.rawQuery {
		t.Errorf("mirror target %s?%s, prod %s?%s", m.path, m.rawQuery, p.path, p.rawQuery)
	}
	for k := range p.header {
		if k == "Date" {
			continue
		}
		if strings.Join(m.header.Values(k), "|") != strings.Join(p.header.Values(k), "|") {
			t.Errorf("header %s: mirror %q, prod %q", k, m.header.Values(k), p.header.Values(k))
		}
	}
	h.waitCounter(t, 1, "ouo_sentry_mirror_requests_total", attribute.String("mirror", "preview"), attribute.String("outcome", "sent"), attribute.String("status_code", "429"))
	h.waitEnvelopes(t, 1)
}

func TestMirrorRewritesCredentials(t *testing.T) {
	prod, preview := newFakeUpstream(t), newFakeUpstream(t)
	h := startReceiver(t, prod.URL, withMirrors(MirrorConfig{Upstream: preview.URL + "/prefix", SentryProjectID: "7", PublicKey: previewKey}))

	// 1. Mobile shape: key in X-Sentry-Auth, no envelope dsn: the body stays byte-identical.
	body := gz(t, []byte(sampleEnvelope))
	hdr := sdkHeaders()
	hdr["X-Sentry-Auth"] = "Sentry sentry_version=7, sentry_client=sentry.cocoa/8.57.0, sentry_key=" + testKey + ", sentry_secret=s3cr3t"
	post(t, h.base+"/api/"+testProject+"/envelope/", body, hdr).Body.Close()
	m := preview.waitRequests(t, 1)[0]
	if m.path != "/prefix/api/7/envelope/" {
		t.Errorf("mirror path %q", m.path)
	}
	if got, want := m.header.Get("X-Sentry-Auth"), "Sentry sentry_version=7, sentry_client=sentry.cocoa/8.57.0, sentry_key="+previewKey; got != want {
		t.Errorf("X-Sentry-Auth\n got %q\nwant %q", got, want)
	}
	if !bytes.Equal(m.body, body) {
		t.Error("body without dsn was changed")
	}
	if p := prod.requests()[0]; p.header.Get("X-Sentry-Auth") != hdr["X-Sentry-Auth"] || p.path != "/api/"+testProject+"/envelope/" {
		t.Errorf("prod request changed: %s %q", p.path, p.header.Get("X-Sentry-Auth"))
	}

	// 2. JS shape: key in the query and the envelope dsn (gzip): both rewritten, the rest kept.
	withDSN := strings.Replace(sampleEnvelope, `"sent_at"`, `"dsn":"https://`+testKey+`@o1.ingest.sentry.io/`+testProject+`","sent_at"`, 1)
	post(t, h.base+"/api/"+testProject+"/envelope/?sentry_version=7&sentry_key="+testKey+"&sentry_client=x", gz(t, []byte(withDSN)),
		map[string]string{"Content-Encoding": "gzip", "Content-Type": "application/x-sentry-envelope"}).Body.Close()
	m = preview.waitRequests(t, 2)[1]
	if m.rawQuery != "sentry_version=7&sentry_key="+previewKey+"&sentry_client=x" {
		t.Errorf("mirror query %q", m.rawQuery)
	}
	zr, err := gzip.NewReader(bytes.NewReader(m.body))
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	first, rest, _ := strings.Cut(string(plain), "\n")
	_, wantRest, _ := strings.Cut(withDSN, "\n")
	if !strings.Contains(first, `"dsn":"http://`+previewKey+`@`+strings.TrimPrefix(preview.URL, "http://")+`/prefix/7"`) {
		t.Errorf("envelope header %s", first)
	}
	if !strings.Contains(first, `"event_id":"9ec79c33ec9942ab8353589fcb2e04dc"`) {
		t.Errorf("envelope header lost fields: %s", first)
	}
	if rest != wantRest {
		t.Error("items changed by the dsn rewrite")
	}
	// The prod copy kept the original dsn.
	if pr := prod.requests()[1]; pr.rawQuery != "sentry_version=7&sentry_key="+testKey+"&sentry_client=x" {
		t.Errorf("prod query changed: %q", pr.rawQuery)
	}
}

// TestMirrorFailuresNeverTouchThePrimary is the failure injection test: a
// hanging, a failing and a throttling mirror next to a healthy primary.
func TestMirrorFailuresNeverTouchThePrimary(t *testing.T) {
	prod := newFakeUpstream(t)
	release := make(chan struct{})
	hang := newFakeUpstream(t)
	hang.reply = func(w http.ResponseWriter) { <-release }
	fail := newFakeUpstream(t)
	fail.reply = func(w http.ResponseWriter) { w.WriteHeader(500) }
	throttle := newFakeUpstream(t)
	throttle.reply = func(w http.ResponseWriter) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(429)
	}
	t.Cleanup(func() { close(release) })
	body := gz(t, []byte(sampleEnvelope))
	h := startReceiver(t, prod.URL,
		withMirrors(
			MirrorConfig{Name: "hang", Upstream: hang.URL},
			MirrorConfig{Name: "fail", Upstream: fail.URL},
			MirrorConfig{Name: "throttle", Upstream: throttle.URL},
		),
		func(c *Config) {
			// Room for 8 copies: the hanging mirror fills it, the rest drop.
			c.Mirror = MirrorSettings{QueueBytes: int64(8 * len(body)), Timeout: 500 * time.Millisecond}
		})

	const n = 40
	var slowest time.Duration
	for range n {
		start := time.Now()
		resp := post(t, h.base+"/api/"+testProject+"/envelope/", body, sdkHeaders())
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(string(b), "9ec79c33") {
			t.Fatalf("SDK got %d %s", resp.StatusCode, b)
		}
		slowest = max(slowest, time.Since(start))
	}
	if slowest > 200*time.Millisecond {
		t.Errorf("slowest primary answer %v with a hanging mirror (timeout 500ms): mirrors must not delay the SDK", slowest)
	}
	if got := len(prod.requests()); got != n {
		t.Errorf("prod saw %d requests, want %d", got, n)
	}
	h.waitEnvelopes(t, n)
	// Every copy is accounted for: answered by the mirror or dropped at the queue.
	h.waitCounter(t, n, "ouo_sentry_mirror_requests_total", attribute.String("mirror", "fail"))
	h.waitCounter(t, n, "ouo_sentry_mirror_requests_total", attribute.String("mirror", "throttle"))
	if h.counter(t, "ouo_sentry_mirror_requests_total", attribute.String("mirror", "fail"), attribute.String("status_code", "500")) == 0 ||
		h.counter(t, "ouo_sentry_mirror_requests_total", attribute.String("mirror", "throttle"), attribute.String("status_code", "429")) == 0 {
		t.Error("the 500 and 429 mirrors were never answered")
	}
	// The hanging mirror: at most 8 copies held (in flight or queued), the
	// rest dropped; the in-flight ones time out.
	h.waitCounter(t, 1, "ouo_sentry_mirror_requests_total", attribute.String("mirror", "hang"), attribute.String("outcome", "error"), attribute.String("reason", "timeout"))
	if d := h.counter(t, "ouo_sentry_mirror_requests_total", attribute.String("mirror", "hang"), attribute.String("outcome", "dropped"), attribute.String("reason", "queue_bytes")); d < n-10 {
		t.Errorf("hang mirror dropped %d, want at least %d", d, n-10)
	}

	// Shutdown is bounded by its context even with the mirror still hanging,
	// and gives every queued byte back.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	if err := h.r.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("shutdown took %v", d)
	}
	if b := h.r.mirrors.budget.used.Load(); b != 0 {
		t.Errorf("mirror budget still holds %d bytes after shutdown", b)
	}
}

func TestMirrorBudgetBoundsMemory(t *testing.T) {
	prod := newFakeUpstream(t)
	release := make(chan struct{})
	hang := newFakeUpstream(t)
	hang.reply = func(w http.ResponseWriter) { <-release }
	t.Cleanup(func() { close(release) }) // before hang.Close (cleanups run last-in first-out)
	body := gz(t, []byte(sampleEnvelope))
	// Room for two bodies in all: the bytes are the limit.
	h := startReceiver(t, prod.URL, withMirrors(MirrorConfig{Name: "hang", Upstream: hang.URL}),
		func(c *Config) {
			c.Mirror = MirrorSettings{QueueBytes: int64(2*len(body) + 1), Timeout: 5 * time.Second}
		})
	for range 10 {
		post(t, h.base+"/api/"+testProject+"/envelope/", body, sdkHeaders()).Body.Close()
	}
	if got := h.r.mirrors.budget.used.Load(); got > int64(2*len(body)) {
		t.Errorf("mirror queue holds %d bytes, limit %d", got, 2*len(body)+1)
	}
	if d := h.counter(t, "ouo_sentry_mirror_requests_total", attribute.String("reason", "queue_bytes")); d != 8 {
		t.Errorf("dropped for bytes: %d, want 8", d)
	}
}

func TestPrimaryDownAbortsAndMirrorGetsNothing(t *testing.T) {
	prod := newFakeUpstream(t)
	url := prod.URL
	prod.Close()
	release := make(chan struct{})
	preview := newFakeUpstream(t)
	preview.reply = func(w http.ResponseWriter) { <-release }
	t.Cleanup(func() { close(release) })
	h := startReceiver(t, url, withMirrors(MirrorConfig{Upstream: preview.URL}))
	for range 3 {
		req, _ := http.NewRequest(http.MethodPost, h.base+"/api/"+testProject+"/envelope/", bytes.NewReader(gz(t, []byte(sampleEnvelope))))
		for k, v := range sdkHeaders() {
			req.Header.Set(k, v)
		}
		start := time.Now()
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			t.Fatalf("SDK got %d; want a network error so it keeps the envelope", resp.StatusCode)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Errorf("abort took %v", d)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(preview.requests()); n != 0 {
		t.Errorf("mirror got %d copies of envelopes the SDK will retry", n)
	}
	h.noEnvelopes(t)
}

func TestUpstreamNoneIsMirrored(t *testing.T) {
	preview := newFakeUpstream(t)
	h := startReceiver(t, UpstreamNone, withMirrors(MirrorConfig{Upstream: preview.URL}))
	body := gz(t, []byte(sampleEnvelope))
	resp := post(t, h.base+"/api/"+testProject+"/envelope/", body, sdkHeaders())
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if m := preview.waitRequests(t, 1)[0]; !bytes.Equal(m.body, body) {
		t.Error("mirror body differs")
	}
}

func TestPassthrough(t *testing.T) {
	prod, fallback, preview := newFakeUpstream(t), newFakeUpstream(t), newFakeUpstream(t)
	fallback.reply = func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"detail":"from sentry"}`))
	}
	h := startReceiver(t, prod.URL, withMirrors(MirrorConfig{Upstream: preview.URL}),
		func(c *Config) { c.PassthroughUpstream = fallback.URL })
	plain := []byte(sampleEnvelope)
	auth := map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + testKey}
	cases := []struct {
		name, method, path string
		hdr                map[string]string
		to                 *fakeUpstream
	}{
		{"unknown key goes to passthrough", "POST", "/api/" + testProject + "/envelope/", map[string]string{"X-Sentry-Auth": "Sentry sentry_key=ffffffffffffffffffffffffffffffff"}, fallback},
		{"unknown project goes to passthrough", "POST", "/api/9999/envelope/", auth, fallback},
		{"no auth goes to passthrough", "POST", "/api/" + testProject + "/envelope/", nil, fallback},
		{"store of a known project goes to its upstream", "POST", "/api/" + testProject + "/store/", auth, prod},
		{"minidump with query key", "POST", "/api/" + testProject + "/minidump/?sentry_key=" + testKey, nil, prod},
		{"security of an unknown project", "POST", "/api/9999/security/?sentry_key=x", nil, fallback},
		{"preflight of another endpoint", "OPTIONS", "/api/9999/store/", nil, fallback},
		{"path outside the ingest routes", "POST", "/api/" + testProject + "/integration/otlp/v1/traces", auth, fallback},
		{"endpoint name longer than the route allows", "POST", "/api/" + testProject + "/" + strings.Repeat("x", 40) + "/", auth, fallback},
		{"GET of a known project's envelope route", "GET", "/api/" + testProject + "/envelope/", auth, fallback},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := len(tc.to.requests())
			req, _ := http.NewRequest(tc.method, h.base+tc.path, bytes.NewReader(plain))
			for k, v := range tc.hdr {
				req.Header.Set(k, v)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if tc.to == fallback && (resp.StatusCode != 403 || string(b) != `{"detail":"from sentry"}`) {
				t.Errorf("SDK got %d %s, want the passthrough's own answer", resp.StatusCode, b)
			}
			reqs := tc.to.requests()
			if len(reqs) != before+1 {
				t.Fatalf("target saw %d new requests", len(reqs)-before)
			}
			got := reqs[len(reqs)-1]
			wantPath, wantQuery, _ := strings.Cut(tc.path, "?")
			if got.method != tc.method || got.path != wantPath || got.rawQuery != wantQuery || (tc.method == "POST" && !bytes.Equal(got.body, plain)) {
				t.Errorf("forwarded %s %s?%s (%d bytes)", got.method, got.path, got.rawQuery, len(got.body))
			}
		})
	}
	h.noEnvelopes(t)
	time.Sleep(50 * time.Millisecond)
	if n := len(preview.requests()); n != 0 {
		t.Errorf("passthrough requests were mirrored %d times", n)
	}
}

func TestTranslatorPanicDoesNotStopTheBridge(t *testing.T) {
	prod := newFakeUpstream(t)
	h := startReceiver(t, prod.URL)
	inner := h.r.onEnvelope
	var panicked atomic.Bool
	h.r.onEnvelope = func(j job, e *Envelope) {
		if panicked.CompareAndSwap(false, true) {
			panic("injected translator bug")
		}
		inner(j, e)
	}
	// Workers run concurrently; send one, wait for the panic, then another.
	post(t, h.base+"/api/"+testProject+"/envelope/", gz(t, []byte(sampleEnvelope)), sdkHeaders()).Body.Close()
	h.waitCounter(t, 1, "ouo_sentry_translate_dropped_total", attribute.String("reason", "panic"))
	resp := post(t, h.base+"/api/"+testProject+"/envelope/", gz(t, []byte(sampleEnvelope)), sdkHeaders())
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("after a translator panic: %d", resp.StatusCode)
	}
	h.waitEnvelopes(t, 1)
	// The worker gives the bytes back right after translating.
	deadline := time.Now().Add(2 * time.Second)
	for h.r.translateBudget.used.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("translate budget holds %d bytes", h.r.translateBudget.used.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRewriteHelpers(t *testing.T) {
	cases := map[string][2]string{
		"Sentry sentry_key=aaa, sentry_version=7":                {"Sentry sentry_key=NEW, sentry_version=7", ""},
		"Sentry sentry_version=7,sentry_client=x,sentry_key=aaa": {"Sentry sentry_version=7,sentry_client=x,sentry_key=NEW", ""},
		"sentry sentry_key=aaa, sentry_secret=bbb":               {"sentry sentry_key=NEW", ""},
		"Bearer abc": {"Bearer abc", ""},
	}
	for in, want := range cases {
		if got := rewriteAuthKey(in, "NEW"); got != want[0] {
			t.Errorf("rewriteAuthKey(%q) = %q, want %q", in, got, want[0])
		}
	}
	q := map[string]string{
		"":               "",
		"sentry_key=aaa": "sentry_key=NEW",
		"a=1&sentry_key=aaa&sentry_secret=b&z=%2F": "a=1&sentry_key=NEW&z=%2F",
		"sentry_keyx=1": "sentry_keyx=1",
	}
	for in, want := range q {
		if got := rewriteQueryKey(in, "NEW"); got != want {
			t.Errorf("rewriteQueryKey(%q) = %q, want %q", in, got, want)
		}
	}
	// No dsn: same slice back. br: cannot be checked.
	b := []byte(sampleEnvelope)
	if out, changed, err := rewriteEnvelopeDSN(b, "", "https://k@h/1", 1<<20); err != nil || changed || &out[0] != &b[0] {
		t.Errorf("no-dsn body: changed=%v err=%v", changed, err)
	}
	if _, _, err := rewriteEnvelopeDSN(b, "br", "https://k@h/1", 1<<20); err == nil {
		t.Error("br body: want an error (counted as body_not_rewritten)")
	}
	if _, _, err := rewriteEnvelopeDSN([]byte(strings.Repeat("x", dsnLineMax+10)+"\n{}"), "", "https://k@h/1", 1<<20); err == nil {
		t.Error("header line over dsnLineMax: want an error")
	}
}

// The dsn rewrite decodes only the header line and streams the rest, so a
// body over 20 MiB is rewritten too, in every encoding, within the limit.
func TestRewriteDSNAnySize(t *testing.T) {
	rest := bytes.Repeat([]byte(`{"type":"attachment","length":1}`+"\nx\n"), int(DefaultMaxTranslateBytes/34)+1000)
	plain := append([]byte(`{"event_id":"e","dsn":"https://old@prod/2"}`+"\n"), rest...)
	const dsn = "https://new@preview/9"
	want := append([]byte(`{"dsn":"https://new@preview/9","event_id":"e"}`+"\n"), rest...)
	encode := map[string]func([]byte) []byte{
		"":     func(b []byte) []byte { return b },
		"gzip": func(b []byte) []byte { return gz(t, b) },
		"deflate": func(b []byte) []byte {
			var z bytes.Buffer
			zw := zlib.NewWriter(&z)
			_, _ = zw.Write(b)
			_ = zw.Close()
			return z.Bytes()
		},
		"deflate (raw)": func(b []byte) []byte {
			var z bytes.Buffer
			fw, _ := flate.NewWriter(&z, flate.BestSpeed)
			_, _ = fw.Write(b)
			_ = fw.Close()
			return z.Bytes()
		},
	}
	for name, enc := range encode {
		t.Run(name, func(t *testing.T) {
			ce, _, _ := strings.Cut(name, " ")
			out, changed, err := rewriteEnvelopeDSN(enc(plain), ce, dsn, 2*DefaultMaxTranslateBytes)
			if err != nil || !changed {
				t.Fatalf("changed=%v err=%v", changed, err)
			}
			got, err := Decompress(out, ce, 1<<30)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Errorf("rewritten body differs (%d vs %d bytes)", len(got), len(want))
			}
		})
	}
}

// A compression bomb with a dsn stops at the limit: the copy goes out as
// received (body_not_rewritten) instead of burning a core.
func TestRewriteDSNBombStopsAtLimit(t *testing.T) {
	plain := append([]byte(`{"dsn":"https://old@prod/2"}`+"\n"), make([]byte, 8<<20)...)
	bomb := gz(t, plain)
	if _, _, err := rewriteEnvelopeDSN(bomb, "gzip", "https://new@preview/9", 1<<20); err == nil {
		t.Fatal("8 MiB decoded over a 1 MiB limit: want an error")
	}
	if _, changed, err := rewriteEnvelopeDSN(bomb, "gzip", "https://new@preview/9", 16<<20); err != nil || !changed {
		t.Fatalf("within the limit: changed=%v err=%v", changed, err)
	}
}

// A handler still waiting on its upstream when Shutdown closed the queues
// drops its copy and translation instead of panicking.
func TestLateEnqueueAfterShutdown(t *testing.T) {
	preview := newFakeUpstream(t)
	h := startReceiver(t, "http://127.0.0.1:1", withMirrors(MirrorConfig{Upstream: preview.URL}))
	h.r.closeQueues()
	req := httptest.NewRequest(http.MethodPost, "/api/"+testProject+"/envelope/", nil)
	p := h.r.projects[testProject+"/"+testKey]
	h.r.mirrorEnvelope(context.Background(), p, req, testProject, testKey, http.Header{}, []byte(sampleEnvelope))
	h.r.enqueue(context.Background(), p, req, []byte(sampleEnvelope), time.Now())
	if n := h.counter(t, "ouo_sentry_translate_dropped_total", attribute.String("reason", "shutdown")); n != 1 {
		t.Errorf("translate dropped(shutdown) = %d, want 1", n)
	}
	if n := h.counter(t, "ouo_sentry_mirror_requests_total", attribute.String("reason", "shutdown")); n != 1 {
		t.Errorf("mirror dropped(shutdown) = %d, want 1", n)
	}
}

func TestMirrorConfigValidate(t *testing.T) {
	good := func() *Config {
		c := createDefaultConfig().(*Config)
		c.Projects = []ProjectConfig{{SentryProjectID: "1", PublicKeys: []string{"k"}, Upstream: "https://o1.ingest.sentry.io", OuoProjectID: "p", ServiceName: "s",
			Mirrors: []MirrorConfig{{Upstream: "https://preview.example.com", SentryProjectID: "7", PublicKey: "abc"}}}}
		c.PassthroughUpstream = "https://o1.ingest.sentry.io"
		return c
	}
	if err := good().Validate(); err != nil {
		t.Fatalf("good config: %v", err)
	}
	bad := map[string]func(*Config){
		"mirror upstream":       func(c *Config) { c.Projects[0].Mirrors[0].Upstream = "preview" },
		"mirror project id":     func(c *Config) { c.Projects[0].Mirrors[0].SentryProjectID = "x" },
		"mirror key with comma": func(c *Config) { c.Projects[0].Mirrors[0].PublicKey = "a,b" },
		"duplicate mirror":      func(c *Config) { c.Projects[0].Mirrors = append(c.Projects[0].Mirrors, c.Projects[0].Mirrors[0]) },
		"passthrough":           func(c *Config) { c.PassthroughUpstream = "none" },
		"negative mirror queue": func(c *Config) { c.Mirror.QueueBytes = -1 },
		"negative queue bytes":  func(c *Config) { c.TranslateQueueBytes = -1 },
	}
	for name, mutate := range bad {
		c := good()
		mutate(c)
		if c.Validate() == nil {
			t.Errorf("%s: Validate accepted it", name)
		}
	}
}
