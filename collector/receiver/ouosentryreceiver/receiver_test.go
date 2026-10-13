package ouosentryreceiver

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/receiver/receivertest"

	"github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver/internal/metadata"
)

const (
	testKey     = "0123456789abcdef0123456789abcdef"
	testProject = "4504"
)

// seenRequest is what the fake upstream received.
type seenRequest struct {
	method, path, rawQuery string
	header                 http.Header
	body                   []byte
}

type fakeUpstream struct {
	*httptest.Server
	mu   sync.Mutex
	seen []seenRequest
	// reply writes the answer; default 200 {"id":"..."}.
	reply func(w http.ResponseWriter)
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	f := &fakeUpstream{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.seen = append(f.seen, seenRequest{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Clone(), b})
		reply := f.reply
		f.mu.Unlock()
		if reply != nil {
			reply(w)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"9ec79c33ec9942ab8353589fcb2e04dc"}`))
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeUpstream) requests() []seenRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]seenRequest(nil), f.seen...)
}

type harness struct {
	r        *sentryReceiver
	base     string
	mu       sync.Mutex
	envs     []*Envelope
	envCount chan struct{}
}

func startReceiver(t *testing.T, upstream string, mutate ...func(*Config)) *harness {
	t.Helper()
	cfg := createDefaultConfig().(*Config)
	cfg.ServerConfig.NetAddr.Endpoint = "127.0.0.1:0"
	cfg.Projects = []ProjectConfig{{
		SentryProjectID: testProject, PublicKeys: []string{testKey}, Upstream: upstream,
		OuoProjectID: "mobile-store", ServiceName: "mobile-store-ios",
	}}
	for _, m := range mutate {
		m(cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("config: %v", err)
	}
	set := receivertest.NewNopSettings(metadata.Type)
	logs, err := createLogs(context.Background(), set, cfg, new(consumertest.LogsSink))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := createTraces(context.Background(), set, cfg, new(consumertest.TracesSink)); err != nil {
		t.Fatal(err)
	}
	r := logs.(*sentryReceiver)
	h := &harness{r: r, envCount: make(chan struct{}, 100)}
	r.onEnvelope = func(_ job, e *Envelope) {
		h.mu.Lock()
		h.envs = append(h.envs, e)
		h.mu.Unlock()
		h.envCount <- struct{}{}
	}
	if err := r.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		t.Fatal(err)
	}
	// A second Start (the traces pipeline) must be a no-op.
	if err := r.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = r.Shutdown(ctx)
		_ = r.Shutdown(ctx)
	})
	h.base = "http://" + r.addr.String()
	return h
}

func (h *harness) waitEnvelopes(t *testing.T, n int) []*Envelope {
	t.Helper()
	for range n {
		select {
		case <-h.envCount:
		case <-time.After(3 * time.Second):
			t.Fatalf("timed out waiting for %d translated envelopes", n)
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]*Envelope(nil), h.envs...)
}

func (h *harness) noEnvelopes(t *testing.T) {
	t.Helper()
	select {
	case <-h.envCount:
		t.Fatal("envelope was queued for translation but should not have been")
	case <-time.After(200 * time.Millisecond):
	}
}

const sampleEnvelope = `{"event_id":"9ec79c33ec9942ab8353589fcb2e04dc","sent_at":"2026-10-14T10:00:00.000Z","sdk":{"name":"sentry.cocoa","version":"8.57.0"}}
{"type":"session","length":117}
{"sid":"7c7b6c2e-4f0d-4b3a-9a3c-1f2e3d4c5b6a","init":true,"started":"2026-10-14T10:00:00Z","attrs":{"release":"a@1"}}
{"type":"event"}
{"event_id":"9ec79c33ec9942ab8353589fcb2e04dc","level":"error"}
`

func gz(t *testing.T, b []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return buf.Bytes()
}

func post(t *testing.T, url string, body []byte, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	// Use a transport that neither adds Accept-Encoding nor decompresses, like an SDK.
	resp, err := (&http.Client{Transport: &http.Transport{DisableCompression: true}}).Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return resp
}

func sdkHeaders() map[string]string {
	return map[string]string{
		"Content-Type":     "application/x-sentry-envelope",
		"Content-Encoding": "gzip",
		"X-Sentry-Auth":    "Sentry sentry_version=7, sentry_client=sentry.cocoa/8.57.0, sentry_key=" + testKey,
		"User-Agent":       "sentry.cocoa/8.57.0",
	}
}

func TestForwardIsByteIdentical(t *testing.T) {
	up := newFakeUpstream(t)
	h := startReceiver(t, up.URL)
	body := gz(t, []byte(sampleEnvelope))
	resp := post(t, h.base+"/api/"+testProject+"/envelope/?sentry_version=7&x=a%2Fb", body, sdkHeaders())
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(got) != `{"id":"9ec79c33ec9942ab8353589fcb2e04dc"}` {
		t.Fatalf("response %d %s", resp.StatusCode, got)
	}
	reqs := up.requests()
	if len(reqs) != 1 {
		t.Fatalf("upstream saw %d requests", len(reqs))
	}
	r := reqs[0]
	if r.method != "POST" || r.path != "/api/"+testProject+"/envelope/" || r.rawQuery != "sentry_version=7&x=a%2Fb" {
		t.Errorf("target: %s %s ? %s", r.method, r.path, r.rawQuery)
	}
	if !bytes.Equal(r.body, body) {
		t.Errorf("body changed: %d bytes sent, %d bytes forwarded", len(body), len(r.body))
	}
	for k, v := range sdkHeaders() {
		if r.header.Get(k) != v {
			t.Errorf("header %s: %q, want %q", k, r.header.Get(k), v)
		}
	}
	if r.header.Get("X-Forwarded-For") != "127.0.0.1" {
		t.Errorf("X-Forwarded-For = %q", r.header.Get("X-Forwarded-For"))
	}
	if r.header.Get("Accept-Encoding") != "" {
		t.Errorf("bridge added Accept-Encoding %q", r.header.Get("Accept-Encoding"))
	}
	envs := h.waitEnvelopes(t, 1)
	if len(envs[0].Items) != 2 || envs[0].Items[0].Type != "session" || envs[0].Header.SDK.Name != "sentry.cocoa" {
		t.Errorf("translated envelope: %+v", envs[0])
	}
}

func TestUpstreamResponsesPassThrough(t *testing.T) {
	cases := []struct {
		name      string
		status    int
		headers   map[string]string
		body      []byte
		translate bool
	}{
		{"ok", 200, map[string]string{"Content-Type": "application/json"}, []byte(`{"id":"abc"}`), true},
		{"rate limited", 429, map[string]string{"X-Sentry-Rate-Limits": "60:error;transaction:organization:quota_exceeded", "Retry-After": "60", "Content-Type": "application/json"}, []byte(`{"detail":"Event dropped due to rate limit"}`), false},
		{"too large", 413, map[string]string{"Content-Type": "application/json"}, []byte(`{"detail":"envelope exceeded size limits"}`), false},
		{"bad request", 400, map[string]string{"Content-Type": "application/json"}, []byte(`{"detail":"invalid event envelope"}`), false},
		{"forbidden", 403, map[string]string{"Content-Type": "application/json"}, []byte(`{"detail":"event submission rejected with_reason: ProjectId"}`), false},
		{"server error", 503, map[string]string{"Retry-After": "5"}, []byte("unavailable"), false},
		{"gzip response untouched", 200, map[string]string{"Content-Encoding": "gzip", "Content-Type": "application/json"}, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := newFakeUpstream(t)
			body := tc.body
			if body == nil {
				body = gz(t, []byte(`{"id":"zipped"}`))
			}
			up.reply = func(w http.ResponseWriter) {
				for k, v := range tc.headers {
					w.Header().Set(k, v)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write(body)
			}
			h := startReceiver(t, up.URL)
			resp := post(t, h.base+"/api/"+testProject+"/envelope/", gz(t, []byte(sampleEnvelope)), sdkHeaders())
			got, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != tc.status || !bytes.Equal(got, body) {
				t.Fatalf("SDK got %d %q, upstream sent %d %q", resp.StatusCode, got, tc.status, body)
			}
			for k, v := range tc.headers {
				if resp.Header.Get(k) != v {
					t.Errorf("response header %s = %q, want %q", k, resp.Header.Get(k), v)
				}
			}
			if tc.translate {
				h.waitEnvelopes(t, 1)
			} else {
				h.noEnvelopes(t)
			}
		})
	}
}

func TestUpstreamUnreachableAbortsConnection(t *testing.T) {
	up := newFakeUpstream(t)
	url := up.URL
	up.Close() // nothing listens there any more
	h := startReceiver(t, url)
	req, _ := http.NewRequest(http.MethodPost, h.base+"/api/"+testProject+"/envelope/", bytes.NewReader(gz(t, []byte(sampleEnvelope))))
	for k, v := range sdkHeaders() {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatalf("SDK got a response (%d); want a network error so it keeps the envelope", resp.StatusCode)
	}
	h.noEnvelopes(t)
}

func TestAuthentication(t *testing.T) {
	up := newFakeUpstream(t)
	h := startReceiver(t, up.URL)
	plain := []byte(sampleEnvelope)
	withDSN := []byte(strings.Replace(sampleEnvelope, `"sent_at"`, `"dsn":"https://`+testKey+`@o1.ingest.sentry.io/`+testProject+`","sent_at"`, 1))
	cases := []struct {
		name   string
		path   string
		body   []byte
		hdr    map[string]string
		status int
	}{
		{"header", "/api/" + testProject + "/envelope/", plain, map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + testKey + ", sentry_version=7"}, 200},
		{"query (JS SDKs)", "/api/" + testProject + "/envelope/?sentry_key=" + testKey + "&sentry_version=7", plain, nil, 200},
		{"envelope dsn plain", "/api/" + testProject + "/envelope/", withDSN, nil, 200},
		{"envelope dsn gzip", "/api/" + testProject + "/envelope/", gz(t, withDSN), map[string]string{"Content-Encoding": "gzip"}, 200},
		{"unknown key", "/api/" + testProject + "/envelope/", plain, map[string]string{"X-Sentry-Auth": "Sentry sentry_key=ffffffffffffffffffffffffffffffff"}, 403},
		{"key of another project", "/api/9999/envelope/", plain, map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + testKey}, 403},
		{"no auth", "/api/" + testProject + "/envelope/", plain, nil, 403},
		{"conflicting header and query", "/api/" + testProject + "/envelope/?sentry_key=ffff", plain, map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + testKey}, 403},
	}
	want := 0
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := post(t, h.base+tc.path, tc.body, tc.hdr)
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != tc.status {
				t.Fatalf("status %d (%s), want %d", resp.StatusCode, b, tc.status)
			}
			if tc.status == 200 {
				want++
			}
			if got := len(up.requests()); got != want {
				t.Fatalf("upstream saw %d requests, want %d (rejected requests must not be forwarded)", got, want)
			}
		})
	}
}

func TestRoutingAndLimits(t *testing.T) {
	up := newFakeUpstream(t)
	h := startReceiver(t, up.URL, func(c *Config) { c.ServerConfig.MaxRequestBodySize = 1024 })
	auth := map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + testKey}

	resp := post(t, h.base+"/api/"+testProject+"/store/", []byte("{}"), auth)
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Errorf("store endpoint: %d, want 404", resp.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodGet, h.base+"/api/"+testProject+"/envelope/", nil)
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 405 {
		t.Errorf("GET envelope: %v %v, want 405", err, resp)
	}
	big := append([]byte(sampleEnvelope), bytes.Repeat([]byte("x"), 2048)...)
	resp = post(t, h.base+"/api/"+testProject+"/envelope/", big, auth)
	resp.Body.Close()
	if resp.StatusCode != 413 {
		t.Errorf("oversized body: %d, want 413", resp.StatusCode)
	}
	if n := len(up.requests()); n != 0 {
		t.Errorf("upstream saw %d requests, want 0", n)
	}
}

func TestUpstreamPathPrefixAndNone(t *testing.T) {
	up := newFakeUpstream(t)
	h := startReceiver(t, up.URL+"/relay/")
	resp := post(t, h.base+"/api/"+testProject+"/envelope/", []byte(sampleEnvelope), map[string]string{"X-Sentry-Auth": "Sentry sentry_key=" + testKey})
	resp.Body.Close()
	if r := up.requests(); len(r) != 1 || r[0].path != "/relay/api/"+testProject+"/envelope/" {
		t.Fatalf("upstream path: %+v", r)
	}

	local := startReceiver(t, UpstreamNone)
	resp = post(t, local.base+"/api/"+testProject+"/envelope/", gz(t, []byte(sampleEnvelope)), sdkHeaders())
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(b), `"id":"9ec79c33ec9942ab8353589fcb2e04dc"`) {
		t.Fatalf("upstream none: %d %s", resp.StatusCode, b)
	}
	local.waitEnvelopes(t, 1)
}

func TestConfigValidate(t *testing.T) {
	good := func() *Config {
		c := createDefaultConfig().(*Config)
		c.Projects = []ProjectConfig{{SentryProjectID: "1", PublicKeys: []string{"k"}, Upstream: "https://o1.ingest.sentry.io", OuoProjectID: "p", ServiceName: "s"}}
		return c
	}
	if err := good().Validate(); err != nil {
		t.Fatalf("good config: %v", err)
	}
	bad := map[string]func(*Config){
		"no projects":      func(c *Config) { c.Projects = nil },
		"non numeric id":   func(c *Config) { c.Projects[0].SentryProjectID = "abc" },
		"no keys":          func(c *Config) { c.Projects[0].PublicKeys = nil },
		"bad upstream":     func(c *Config) { c.Projects[0].Upstream = "ftp://x" },
		"upstream query":   func(c *Config) { c.Projects[0].Upstream = "https://x/?a=b" },
		"bad ouo project":  func(c *Config) { c.Projects[0].OuoProjectID = "Bad Name" },
		"no service name":  func(c *Config) { c.Projects[0].ServiceName = "" },
		"duplicate key":    func(c *Config) { c.Projects = append(c.Projects, c.Projects[0]) },
		"negative timeout": func(c *Config) { c.UpstreamTimeout = -1 },
	}
	for name, mutate := range bad {
		c := good()
		mutate(c)
		if c.Validate() == nil {
			t.Errorf("%s: Validate accepted it", name)
		}
	}
}
