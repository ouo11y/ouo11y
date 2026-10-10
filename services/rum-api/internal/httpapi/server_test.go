package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/ingest"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/loki"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/project"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/replay"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/session"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/tempo"
)

const (
	realSession = "a4d47dfa-db30-4856-9bfe-3a657ccc9471"
	testToken   = "pt_dev_demo_0000000000000000"
	otherToken  = "pt_dev_other_000000000000000"
	readToken   = "rt_dev_0000000000000000"
)

type fakeEvents struct {
	events  []session.Event
	err     error
	mu      sync.Mutex
	filters []loki.Filters
	ranges  [][2]time.Time
}

func (f *fakeEvents) Events(ctx context.Context, fl loki.Filters, start, end time.Time) ([]session.Event, error) {
	f.mu.Lock()
	f.filters = append(f.filters, fl)
	f.ranges = append(f.ranges, [2]time.Time{start, end})
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	// Mimic Loki's label / metadata filters.
	var out []session.Event
	for _, ev := range f.events {
		if (fl.SessionID != "" && ev.SessionID != fl.SessionID) || (fl.Platform != "" && ev.Platform != fl.Platform) ||
			(fl.Service != "" && ev.ServiceName != fl.Service) || (fl.Version != "" && ev.ServiceVersion != fl.Version) ||
			(fl.User != "" && ev.UserID != fl.User) {
			continue
		}
		out = append(out, ev)
	}
	return out, nil
}
func (f *fakeEvents) Ready(context.Context) error { return nil }

type fakeTraces struct {
	traces map[string][]tempo.Trace
	err    error
}

func (f *fakeTraces) SessionTraces(ctx context.Context, id string, start, end time.Time) ([]tempo.Trace, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.traces[id], nil
}
func (f *fakeTraces) Ready(context.Context) error { return errors.New("tempo down") }

func fixtureEvents(t *testing.T) []session.Event {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "session", "testdata", "loki_web_real.json"))
	if err != nil {
		t.Fatal(err)
	}
	evs, err := session.ParseLokiResponse(b)
	if err != nil {
		t.Fatal(err)
	}
	// Add a healthy mobile session 30 s later.
	base := evs[len(evs)-1].TS.Add(30 * time.Second)
	evs = append(evs, session.Event{TS: base, Name: "session.start", SessionID: "mobile-1", UserID: "m1", Platform: "mobile", ServiceName: "mobile-store", ServiceVersion: "9.9.9", Attrs: map[string]string{}})
	return evs
}

func newTestServer(t *testing.T) (*httptest.Server, *fakeEvents, *replay.FS) {
	return newTestServerWith(t, nil)
}

// testGateway is a gateway with the demo project (token testToken, origins
// http://localhost:*) and a second project `other`; the collector endpoint
// points nowhere (these tests never forward OTLP).
func testGateway(t *testing.T, mod func(*ingest.Options)) *ingest.Gateway {
	t.Helper()
	reg, err := project.New([]*project.Project{
		{ID: "demo", Tokens: []string{testToken}, AllowedOrigins: []string{"http://localhost:*", "http://127.0.0.1:*"}},
		{ID: "other", Tokens: []string{otherToken}, AllowedOrigins: []string{"https://other.example"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	opts := ingest.Options{Registry: reg, CollectorEndpoint: "http://127.0.0.1:1"}
	if mod != nil {
		mod(&opts)
	}
	gw, err := ingest.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return gw
}

func newTestServerWith(t *testing.T, mod func(*Options)) (*httptest.Server, *fakeEvents, *replay.FS) {
	t.Helper()
	evs := fixtureEvents(t)
	fe := &fakeEvents{events: evs}
	ft := &fakeTraces{traces: map[string][]tempo.Trace{
		realSession: {{TraceID: "aaa", RootName: "documentLoad", SpanCount: 4, GrafanaURL: "http://g/explore?x"}, {TraceID: "bbb", RootName: "GET", HasError: true}},
	}}
	store, err := replay.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := evs[len(evs)-1].TS.Add(time.Minute)
	opts := Options{Now: func() time.Time { return now }, Gateway: testGateway(t, nil)}
	if mod != nil {
		mod(&opts)
	}
	srv := New(fe, ft, store, opts)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, fe, store
}

// postChunk posts a chunk body with the demo token and optional extra headers.
func postChunk(t *testing.T, url string, body io.Reader, headers ...string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ingest.TokenHeader, testToken)
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func getJSON(t *testing.T, url string, v any) int {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if v != nil {
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			t.Fatalf("decode %s: %v", url, err)
		}
	}
	return resp.StatusCode
}

func TestCORSPreflight(t *testing.T) {
	ts, _, _ := newTestServerWith(t, func(o *Options) { o.CORSAllowedOrigins = []string{"https://legacy.example/"} })
	preflight := func(origin, path string) *http.Response {
		req, _ := http.NewRequest(http.MethodOptions, ts.URL+path, nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "content-type,x-ouo-project-token")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	// Allowed by the demo project: answered with the full header set.
	resp := preflight("http://localhost:5173", "/ingest/otlp/v1/traces")
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatalf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
	for _, h := range []string{"X-Ouo-Project-Token", "Content-Type", "Content-Encoding", "traceparent", "baggage", "Authorization", "X-Ouo-Session-Id", "X-Ouo-Seq", "Accept", "Accept-Encoding"} {
		if !strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), h) {
			t.Errorf("allow-headers missing %s: %s", h, resp.Header.Get("Access-Control-Allow-Headers"))
		}
	}
	if !strings.Contains(resp.Header.Get("Access-Control-Allow-Methods"), "DELETE") || !strings.Contains(resp.Header.Get("Vary"), "Origin") {
		t.Errorf("allow-methods / vary: %v", resp.Header)
	}
	// Allowed by the other project only: a preflight carries no token, so any project counts.
	if resp = preflight("https://other.example", "/v1/replay/chunks"); resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Origin") != "https://other.example" {
		t.Fatalf("other project preflight: %d %v", resp.StatusCode, resp.Header)
	}
	// Deprecated CORS_ALLOWED_ORIGINS still works for the read side.
	if resp = preflight("https://legacy.example", "/v1/sessions"); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("legacy origin preflight: %d", resp.StatusCode)
	}
	// Disallowed origin: 403, no CORS headers. The old reflect-any-localhost
	// behaviour is gone: localhost is allowed only because the demo project lists it.
	for _, o := range []string{"http://evil.example", "https://localhost:5173", "http://localhost.evil:5173"} {
		if resp = preflight(o, "/ingest/otlp/v1/traces"); resp.StatusCode != http.StatusForbidden || resp.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("preflight %s: %d %v", o, resp.StatusCode, resp.Header)
		}
	}
	// Foreign origin on a plain request: no CORS headers, request still served.
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/healthz", nil)
	req.Header.Set("Origin", "http://evil.example")
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 200 || resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("foreign origin: %d %v", resp.StatusCode, resp.Header)
	}
	// Allowed origin on a plain request: headers set, Retry-After exposed.
	req.Header.Set("Origin", "http://127.0.0.1:3000")
	resp, _ = http.DefaultClient.Do(req)
	if resp.Header.Get("Access-Control-Allow-Origin") != "http://127.0.0.1:3000" || !strings.Contains(resp.Header.Get("Access-Control-Expose-Headers"), "Retry-After") {
		t.Fatalf("allowed origin: %v", resp.Header)
	}
}

func TestReadToken(t *testing.T) {
	ts, _, store := newTestServerWith(t, func(o *Options) { o.ReadToken = readToken })
	store.Put(context.Background(), "demo", []byte(`{"session_id":"rt-1","seq":0,"started_at":1,"ended_at":2,"events":[{"type":4}]}`), nil)
	do := func(method, path, auth string) *http.Response {
		req, _ := http.NewRequest(method, ts.URL+path, nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	// Every GET and DELETE under /v1 needs the bearer token.
	for _, path := range []string{"/v1/sessions", "/v1/sessions/rt-1", "/v1/sessions/rt-1/traces", "/v1/sessions/rt-1/replay", "/v1/sessions/rt-1/replay/events", "/v1/stats/health"} {
		if resp := do(http.MethodGet, path, ""); resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("WWW-Authenticate") == "" {
			t.Fatalf("GET %s without token: %d %v", path, resp.StatusCode, resp.Header)
		}
		if resp := do(http.MethodGet, path, "Bearer wrong"); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("GET %s wrong token: %d", path, resp.StatusCode)
		}
		if resp := do(http.MethodGet, path, "Basic "+readToken); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("GET %s wrong scheme: %d", path, resp.StatusCode)
		}
		if resp := do(http.MethodGet, path, "Bearer "+readToken); resp.StatusCode == http.StatusUnauthorized {
			t.Fatalf("GET %s with token: %d", path, resp.StatusCode)
		}
	}
	if resp := do(http.MethodDelete, "/v1/sessions/rt-1/replay", ""); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("DELETE without token: %d", resp.StatusCode)
	}
	if resp := do(http.MethodDelete, "/v1/sessions/rt-1/replay", "bearer "+readToken); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE with token: %d", resp.StatusCode)
	}
	// Probes and ingest stay open (ingest has its own token).
	for _, path := range []string{"/healthz", "/readyz"} {
		if resp := do(http.MethodGet, path, ""); resp.StatusCode == http.StatusUnauthorized {
			t.Fatalf("GET %s: %d", path, resp.StatusCode)
		}
	}
	chunk := `{"session_id":"rt-2","seq":0,"started_at":1,"ended_at":2,"events":[{"type":4}]}`
	if resp := postChunk(t, ts.URL+"/v1/replay/chunks", strings.NewReader(chunk)); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST chunk without read token: %d", resp.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/ingest/otlp/v1/traces", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ingest.TokenHeader, testToken)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode == http.StatusUnauthorized {
		t.Fatalf("ingest behind read token: %d", resp.StatusCode)
	}
	// Preflights are not behind it either.
	req, _ = http.NewRequest(http.MethodOptions, ts.URL+"/v1/sessions", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "GET")
	if resp, _ = http.DefaultClient.Do(req); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight behind read token: %d", resp.StatusCode)
	}
}

func TestReplayChunkAuth(t *testing.T) {
	ts, _, store := newTestServerWith(t, func(o *Options) {
		o.Gateway = testGateway(t, func(g *ingest.Options) { g.IPRateLimitRPS, g.IPRateLimitBurst = 1, 3 })
	})
	url := ts.URL + "/v1/replay/chunks"
	chunk := func(id string, seq int) io.Reader {
		return strings.NewReader(`{"session_id":"` + id + `","seq":` + string(rune('0'+seq)) + `,"started_at":1,"ended_at":2,"events":[{"type":4}]}`)
	}
	raw := func(headers ...string) *http.Response {
		req, _ := http.NewRequest(http.MethodPost, url, chunk("auth-1", 0))
		req.Header.Set("Content-Type", "application/json")
		for i := 0; i+1 < len(headers); i += 2 {
			req.Header.Set(headers[i], headers[i+1])
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	if resp := raw(); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: %d", resp.StatusCode)
	}
	if resp := raw(ingest.TokenHeader, "pt_nope"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown token: %d", resp.StatusCode)
	}
	if resp := raw(ingest.TokenHeader, testToken, "Origin", "https://evil.example"); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("bad origin: %d", resp.StatusCode)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/auth-1/replay", nil); code != 404 {
		t.Fatalf("rejected chunk stored: %d", code)
	}
	// Accepted with the token and an allowed origin: project_id lands in meta.json.
	if resp := raw(ingest.TokenHeader, testToken, "Origin", "http://localhost:5173"); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("ok: %d", resp.StatusCode)
	}
	var m replay.Meta
	getJSON(t, ts.URL+"/v1/sessions/auth-1/replay", &m)
	if m.ProjectID != "demo" {
		t.Fatalf("meta project: %+v", m)
	}
	b, _ := os.ReadFile(filepath.Join(store.Root, "auth-1", "meta.json"))
	if !strings.Contains(string(b), `"project_id": "demo"`) {
		t.Fatalf("meta.json: %s", b)
	}
	// Another project cannot append to that session.
	if resp := raw(ingest.TokenHeader, otherToken); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross project: %d", resp.StatusCode)
	}
	// A pre-8a replay (no project_id) adopts the first project that writes to it.
	legacy := filepath.Join(store.Root, "legacy-1")
	os.MkdirAll(legacy, 0o755)
	os.WriteFile(filepath.Join(legacy, "meta.json"), []byte(`{"session_id":"legacy-1","chunk_count":0,"chunks":[]}`), 0o644)
	req, _ := http.NewRequest(http.MethodPost, url, chunk("legacy-1", 1))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ingest.TokenHeader, otherToken)
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("legacy adopt: %d", resp.StatusCode)
	}
	getJSON(t, ts.URL+"/v1/sessions/legacy-1/replay", &m)
	if m.ProjectID != "other" || m.Kind != "rrweb" {
		t.Fatalf("legacy meta: %+v", m)
	}
	// Rate limit: the IP bucket (burst 3) is spent by the three requests
	// above that passed token and origin (rejections before the rate check
	// do not spend a token); the next one is 429 with Retry-After.
	resp := raw(ingest.TokenHeader, testToken)
	if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("rate limit: %d %v", resp.StatusCode, resp.Header)
	}
}

func TestReplayRoundTrip(t *testing.T) {
	ts, _, _ := newTestServer(t)
	id := "11111111-2222-4333-8444-555555555555"
	chunk := func(seq int, events ...any) []byte {
		b, _ := json.Marshal(map[string]any{"session_id": id, "seq": seq, "started_at": 1000 + seq*5000, "ended_at": 5000 + seq*5000, "events": events})
		return b
	}
	meta := map[string]any{"type": 4, "data": map[string]any{"href": "http://localhost:5173/"}, "timestamp": 1000}
	full := map[string]any{"type": 2, "data": map[string]any{"node": map[string]any{"type": 0}}, "timestamp": 1001}
	inc := map[string]any{"type": 3, "data": map[string]any{"source": 2}, "timestamp": 6000}

	// gzip upload (seq 0) as the SDK does
	var gz bytes.Buffer
	gw := gzip.NewWriter(&gz)
	gw.Write(chunk(0, meta, full))
	gw.Close()
	resp := postChunk(t, ts.URL+"/v1/replay/chunks", &gz, "Content-Encoding", "gzip", "X-Ouo-Session-Id", id, "X-Ouo-Seq", "0")
	var ack map[string]any
	json.NewDecoder(resp.Body).Decode(&ack)
	if resp.StatusCode != http.StatusAccepted || ack["accepted"] != true || ack["seq"].(float64) != 0 {
		t.Fatalf("gzip post: %d %v", resp.StatusCode, ack)
	}
	// plain upload (seq 1, keepalive path)
	resp = postChunk(t, ts.URL+"/v1/replay/chunks", bytes.NewReader(chunk(1, inc)))
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("plain post: %d", resp.StatusCode)
	}
	// invalid
	resp = postChunk(t, ts.URL+"/v1/replay/chunks", strings.NewReader(`{"session_id":"../x","seq":0,"events":[]}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid chunk: %d", resp.StatusCode)
	}
	resp = postChunk(t, ts.URL+"/v1/replay/chunks", strings.NewReader(`not json`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("not json: %d", resp.StatusCode)
	}
	// too large
	big := bytes.Repeat([]byte("x"), 5<<20)
	resp = postChunk(t, ts.URL+"/v1/replay/chunks", bytes.NewReader(big))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large: %d", resp.StatusCode)
	}
	// bad gzip
	resp = postChunk(t, ts.URL+"/v1/replay/chunks", strings.NewReader("nope"), "Content-Encoding", "gzip")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad gzip: %d", resp.StatusCode)
	}

	var m replay.Meta
	if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay", &m); code != 200 {
		t.Fatalf("meta: %d", code)
	}
	if m.ChunkCount != 2 || m.StartedAt != 1000 || m.EndedAt != 10000 || len(m.Chunks) != 2 || m.Chunks[1].Seq != 1 || m.ProjectID != "demo" {
		t.Fatalf("meta: %+v", m)
	}

	// events, gzip negotiated
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/sessions/"+id+"/replay/events", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	tr := &http.Transport{DisableCompression: true}
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("events: %d %v", resp.StatusCode, resp.Header)
	}
	gr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(gr)
	var events []map[string]any
	if err := json.Unmarshal(body, &events); err != nil {
		t.Fatalf("events body: %v %s", err, body)
	}
	if len(events) != 3 || events[0]["type"].(float64) != 4 || events[1]["type"].(float64) != 2 || events[2]["type"].(float64) != 3 {
		t.Fatalf("events: %v", events)
	}
	// plain events
	resp, _ = (&http.Client{Transport: tr}).Get(ts.URL + "/v1/sessions/" + id + "/replay/events")
	if resp.Header.Get("Content-Encoding") != "" {
		t.Fatalf("unexpected encoding")
	}
	body, _ = io.ReadAll(resp.Body)
	if !bytes.HasPrefix(body, []byte("[{")) {
		t.Fatalf("plain body: %s", body)
	}

	// delete
	req, _ = http.NewRequest(http.MethodDelete, ts.URL+"/v1/sessions/"+id+"/replay", nil)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay", nil); code != 404 {
		t.Fatalf("after delete: %d", code)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay/events", nil); code != 404 {
		t.Fatalf("events after delete: %d", code)
	}
}

func TestListSessions(t *testing.T) {
	ts, fe, store := newTestServer(t)
	// give the real session a replay
	store.Put(context.Background(), "demo", []byte(`{"session_id":"`+realSession+`","seq":0,"started_at":1,"ended_at":2,"events":[{"type":4}]}`), nil)

	var list listResponse
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h", &list); code != 200 {
		t.Fatalf("list: %d", code)
	}
	if list.Count != 2 || len(list.Sessions) != 2 {
		t.Fatalf("list: %+v", list)
	}
	if list.Sessions[0].SessionID != "mobile-1" || list.Sessions[1].SessionID != realSession {
		t.Fatalf("order (started_at desc): %s %s", list.Sessions[0].SessionID, list.Sessions[1].SessionID)
	}
	web := list.Sessions[1]
	if web.Status != session.StatusCrashed || web.TraceCount != 2 || !web.HasReplay || web.UserID != "3c63803d-6d13-4d79-944a-72c1c26f23cb" || web.State != session.StateActive {
		t.Fatalf("web record: %+v", web)
	}
	if m := list.Sessions[0]; m.TraceCount != 0 || m.HasReplay || m.Platform != "mobile" || m.Status != session.StatusHealthy {
		t.Fatalf("mobile record: %+v", m)
	}
	// Loki window starts lookback before from.
	last := fe.ranges[len(fe.ranges)-1]
	if last[1].Sub(last[0]) != 2*time.Hour+4*time.Hour {
		t.Fatalf("loki window: %v", last)
	}

	// filters pass through and status is applied after folding
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h&status=healthy&platform=mobile&version=9.9.9&user=m1&service=mobile-store", &list); code != 200 || list.Count != 1 || list.Sessions[0].SessionID != "mobile-1" {
		t.Fatalf("filtered: %d %+v", code, list)
	}
	f := fe.filters[len(fe.filters)-1]
	if f.Platform != "mobile" || f.Version != "9.9.9" || f.User != "m1" || f.Service != "mobile-store" {
		t.Fatalf("filters: %+v", f)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h&status=crashed", &list); code != 200 || list.Count != 1 || list.Sessions[0].SessionID != realSession {
		t.Fatalf("crashed filter: %+v", list)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h&limit=1", &list); code != 200 || list.Count != 1 {
		t.Fatalf("limit: %+v", list)
	}
	// a range that excludes both sessions
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-30s", &list); code != 200 || list.Count != 0 || list.Sessions == nil {
		t.Fatalf("empty range: %+v", list)
	}
	// bad input
	for _, q := range []string{"from=bogus", "status=meh", "limit=0", "from=now&to=now-1h"} {
		if code := getJSON(t, ts.URL+"/v1/sessions?"+q, nil); code != 400 {
			t.Errorf("%s: want 400 got %d", q, code)
		}
	}
	// loki failure
	fe.err = errors.New("connection refused")
	if code := getJSON(t, ts.URL+"/v1/sessions", nil); code != http.StatusBadGateway {
		t.Fatalf("loki down: %d", code)
	}
	fe.err = nil
}

func TestSessionDetailAndTraces(t *testing.T) {
	ts, _, _ := newTestServer(t)
	var d detailResponse
	if code := getJSON(t, ts.URL+"/v1/sessions/"+realSession, &d); code != 200 {
		t.Fatalf("detail: %d", code)
	}
	if d.SessionID != realSession || d.Status != session.StatusCrashed || d.TraceCount != 2 || d.ErrorCount != 2 || d.CrashCount != 1 {
		t.Fatalf("detail record: %+v", d.Record)
	}
	if len(d.Timeline) != 12 || d.Timeline[0].Type != session.TypeSessionStart {
		t.Fatalf("timeline: %+v", d.Timeline)
	}
	for i := 1; i < len(d.Timeline); i++ {
		if d.Timeline[i].TS.Before(d.Timeline[i-1].TS) {
			t.Fatalf("timeline not ordered at %d", i)
		}
	}
	var types []session.Type
	for _, it := range d.Timeline {
		types = append(types, it.Type)
		if it.Type == session.TypeCustom && it.Name != "cart.added" {
			t.Errorf("custom name: %s", it.Name)
		}
		if it.Type == session.TypeRequestFailed && it.Attrs["http_response_status_code"] != "500" {
			t.Errorf("failed request attrs: %v", it.Attrs)
		}
	}
	if types[3] != session.TypeRequestFailed || types[8] != session.TypeException {
		t.Fatalf("types: %v", types)
	}
	if len(d.Traces) != 2 || d.Traces[0].GrafanaURL == "" || !d.Traces[1].HasError {
		t.Fatalf("traces: %+v", d.Traces)
	}
	// JSON shape: record fields flattened at top level
	resp, _ := http.Get(ts.URL + "/v1/sessions/" + realSession)
	var raw map[string]any
	json.NewDecoder(resp.Body).Decode(&raw)
	for _, k := range []string{"session_id", "status", "state", "ended_at", "end_reason", "timeline", "traces", "has_replay", "trace_count", "failed_request_count", "event_count"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("detail json missing %s", k)
		}
	}
	if raw["ended_at"] != nil || raw["end_reason"] != nil {
		t.Errorf("active session must serialise ended_at/end_reason as null: %v %v", raw["ended_at"], raw["end_reason"])
	}

	if code := getJSON(t, ts.URL+"/v1/sessions/does-not-exist", nil); code != 404 {
		t.Fatalf("unknown session: %d", code)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/bad%20id", nil); code != 400 {
		t.Fatalf("bad id: %d", code)
	}

	var tr tracesResponse
	if code := getJSON(t, ts.URL+"/v1/sessions/"+realSession+"/traces", &tr); code != 200 || tr.Count != 2 || tr.SessionID != realSession {
		t.Fatalf("traces: %d %+v", code, tr)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/unknown-session/traces", &tr); code != 200 || tr.Count != 0 || tr.Traces == nil {
		t.Fatalf("traces unknown: %d %+v", code, tr)
	}
}

func TestStatsHealth(t *testing.T) {
	ts, _, _ := newTestServer(t)
	var st statsResponse
	if code := getJSON(t, ts.URL+"/v1/stats/health?from=now-2h", &st); code != 200 {
		t.Fatalf("stats: %d", code)
	}
	if len(st.Buckets) != 2 || st.Totals.Total != 2 || st.Totals.CrashedPct != 50 || st.Totals.HealthyPct != 50 {
		t.Fatalf("stats: %+v", st)
	}
	if st.Buckets[1].Platform != "web" || st.Buckets[1].ServiceVersion != "1.4.2" || st.Buckets[1].CrashedPct != 100 {
		t.Fatalf("web bucket: %+v", st.Buckets[1])
	}
	if code := getJSON(t, ts.URL+"/v1/stats/health?from=now-2h&platform=mobile", &st); code != 200 || len(st.Buckets) != 1 || st.Buckets[0].HealthyPct != 100 {
		t.Fatalf("mobile stats: %+v", st)
	}
	if code := getJSON(t, ts.URL+"/v1/stats/health?from=now-30s", &st); code != 200 || st.Buckets == nil || st.Totals.Total != 0 {
		t.Fatalf("empty stats: %+v", st)
	}
}

func TestReadyz(t *testing.T) {
	ts, _, _ := newTestServer(t)
	var r map[string]any
	if code := getJSON(t, ts.URL+"/readyz", &r); code != http.StatusServiceUnavailable || r["ready"] != false {
		t.Fatalf("readyz with tempo down: %d %v", code, r)
	}
	if code := getJSON(t, ts.URL+"/healthz", &r); code != 200 {
		t.Fatalf("healthz: %d", code)
	}
	if code := getJSON(t, ts.URL+"/nope", &r); code != 404 {
		t.Fatalf("404: %d", code)
	}
}

func TestTempoFailureIsBestEffort(t *testing.T) {
	evs := fixtureEvents(t)
	store, _ := replay.NewFS(t.TempDir())
	now := evs[len(evs)-1].TS.Add(time.Minute)
	srv := New(&fakeEvents{events: evs}, &fakeTraces{err: errors.New("tempo down")}, store, Options{Now: func() time.Time { return now }, Gateway: testGateway(t, nil)})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	var list listResponse
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h", &list); code != 200 || list.Count != 2 {
		t.Fatalf("list: %d %+v", code, list)
	}
	for _, s := range list.Sessions {
		if s.TraceCount != -1 {
			t.Fatalf("trace_count should be -1 on tempo error: %+v", s)
		}
	}
	var d detailResponse
	if code := getJSON(t, ts.URL+"/v1/sessions/"+realSession, &d); code != 200 || len(d.Traces) != 0 || d.TraceCount != -1 {
		t.Fatalf("detail: %d %+v", code, d)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/"+realSession+"/traces", nil); code != http.StatusBadGateway {
		t.Fatalf("traces endpoint should surface tempo error: %d", code)
	}
}
