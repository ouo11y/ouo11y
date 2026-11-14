package ouogo

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	proj    = "demo"
	sess    = "0123456789abcdef0123456789abcdef"
	replay  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	stream  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	readTok = "mrt_test"
)

// labels of one record as Loki answers them: stream labels and structured metadata merged.
func record(event string, extra map[string]string) map[string]string {
	l := map[string]string{
		"service_name": "shop-web", "ouo_project_id": proj, "session_id": sess,
		"event_name": event, "ouo_view_id": "v1", "severity_text": "INFO",
		"trace_id": "t1", "span_id": "s1",
	}
	for k, v := range extra {
		l[k] = v
	}
	return l
}

type fakeLoki struct {
	queries []string
	limits  []string
}

func (f *fakeLoki) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("query")
	f.queries = append(f.queries, q)
	if l := r.URL.Query().Get("limit"); l != "" {
		f.limits = append(f.limits, l)
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/loki/api/v1/query_range":
		if strings.Contains(q, "ffffffffffffffffffffffffffffffff") {
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[]}}`))
			return
		}
		streams := []map[string]any{
			{"stream": record("session.start", nil), "values": [][2]string{{"1794400000000000000", ""}}},
			{"stream": record("browser.navigation", map[string]string{
				"browser_document_url_full": "https://shop.example/cart",
				"enduser_id":                "user-42",
				"user_agent_original":       "Mozilla/5.0",
			}), "values": [][2]string{{"1794400001000000000", ""}}},
			{"stream": record("exception", map[string]string{"severity_text": "ERROR", "exception_message": "boom"}),
				"values": [][2]string{{"1794400002000000000", "stack body"}}},
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": streams}})
	case "/loki/api/v1/query":
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": []map[string]any{
			{"metric": map[string]string{"ouo_project_id": proj, "session_id": sess}, "value": []any{1794400002.0, "3"}},
		}}})
	default:
		http.NotFound(w, r)
	}
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return buf.Bytes()
}

type fakeMuninn struct{ calls int }

const chunkBody = `{"type":4,"data":{"href":"https://shop.example/"},"timestamp":1}` + "\n"

func (f *fakeMuninn) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls++
	if r.Header.Get("Authorization") != "Bearer "+readTok || r.Header.Get("X-Scope-OrgID") != "anonymous" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	base := "/api/v1/projects/" + proj + "/sessions/" + sess + "/replays"
	switch r.URL.Path {
	case base:
		_, _ = w.Write([]byte(`{"session_id":"` + sess + `","replays":[{"replay_id":"` + replay + `","state":"complete","start_time":1,"end_time":2,"chunk_count":1,"byte_size":10,"formats":["rrweb/2"],"stream_count":1}]}`))
	case base + "/" + replay:
		// Muninn gzips JSON when the request accepts it.
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(gz([]byte(`{"session_id":"` + sess + `","replay_id":"` + replay + `","project":"demo","state":"complete","streams":[{"stream_id":"` + stream + `","state":"complete","end":null,"missing":[],"chunks":[{"sequence":0,"keyframe":true,"format":"rrweb/2","encoding":"gzip","attributes":{"ouo.replay.masked":true,"enduser.id":"user-42"},"path":"/x"}]}]}`)))
	case base + "/" + replay + "/streams/" + stream + "/chunks/0":
		if r.Header.Get("Accept-Encoding") != "gzip" {
			http.Error(w, "want Accept-Encoding gzip", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("X-Ouo-Replay-Format", "rrweb/2")
		_, _ = w.Write(gz([]byte(chunkBody)))
	default:
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
	}
}

type fixture struct {
	loki   *Loki
	muninn *Muninn
	fl     *fakeLoki
	fm     *fakeMuninn
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	fl, fm := &fakeLoki{}, &fakeMuninn{}
	ls, ms := httptest.NewServer(fl), httptest.NewServer(fm)
	t.Cleanup(ls.Close)
	t.Cleanup(ms.Close)
	now := time.Unix(1794400010, 0)
	return &fixture{
		loki:   &Loki{URL: ls.URL, Now: func() time.Time { return now }},
		muninn: &Muninn{URL: ms.URL, ReadToken: readTok},
		fl:     fl, fm: fm,
	}
}

func TestListSessions(t *testing.T) {
	f := newFixture(t)
	list, err := f.loki.ListSessions(context.Background(), SessionQuery{})
	if err != nil {
		t.Fatal(err)
	}
	want := Session{Project: proj, ID: sess, Service: "shop-web", Start: 1794400000000, End: 1794400002000,
		EventCount: 3, ErrorCount: 1, HasReplay: true, User: "user-42"}
	if len(list.Sessions) != 1 || list.Sessions[0] != want || list.Truncated {
		t.Errorf("got %+v\nwant one session %+v", list, want)
	}
	f.loki.ListLimit = 3
	if list, _ := f.loki.ListSessions(context.Background(), SessionQuery{}); !list.Truncated {
		t.Errorf("a list at ListLimit must say truncated")
	}
}

func TestSessionEvents(t *testing.T) {
	f := newFixture(t)
	d, err := f.loki.SessionEvents(context.Background(), proj, sess, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Events) != 3 || d.Truncated || d.Session.User != "user-42" || d.Session.EventCount != 3 || d.Session.HasReplay {
		t.Fatalf("got %+v", d)
	}
	cases := []struct {
		i                          int
		name, severity, view, body string
		attrs                      map[string]string
	}{
		{0, "session.start", "INFO", "v1", "", nil},
		{1, "browser.navigation", "INFO", "v1", "", map[string]string{
			"browser_document_url_full": "https://shop.example/cart", "enduser_id": "user-42", "user_agent_original": "Mozilla/5.0"}},
		{2, "exception", "ERROR", "v1", "stack body", map[string]string{"exception_message": "boom"}},
	}
	for _, c := range cases {
		e := d.Events[c.i]
		if e.Name != c.name || e.Severity != c.severity || e.ViewID != c.view || e.Body != c.body ||
			e.TraceID != "t1" || e.SpanID != "s1" || fmt.Sprint(e.Attributes) != fmt.Sprint(c.attrs) {
			t.Errorf("event %d: %+v", c.i, e)
		}
	}
	f.loki.EventLimit = 3
	if d, _ := f.loki.SessionEvents(context.Background(), proj, sess, TimeRange{}); !d.Truncated {
		t.Errorf("a session at the event limit must say truncated")
	}
}

func TestSentryBridgeUser(t *testing.T) {
	var s Session
	s.add(LokiLine{Time: time.Unix(1, 0), Labels: map[string]string{"user_id": "sentry-user"}})
	if s.User != "sentry-user" {
		t.Errorf("user from user.id: %q", s.User)
	}
	s.add(LokiLine{Time: time.Unix(2, 0), Labels: map[string]string{"enduser_id": "later"}})
	if s.User != "sentry-user" {
		t.Errorf("the first user seen stays: %q", s.User)
	}
}

func TestMuninnReads(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	rs, err := f.muninn.ListReplays(ctx, proj, sess)
	if err != nil || len(rs) != 1 || rs[0].ReplayID != replay || rs[0].Formats[0] != "rrweb/2" {
		t.Fatalf("replays %+v %v", rs, err)
	}
	m, err := f.muninn.Manifest(ctx, proj, sess, replay)
	if err != nil {
		t.Fatal(err)
	}
	c := m.Streams[0].Chunks[0]
	if m.Streams[0].StreamID != stream || !c.Keyframe || c.Format != "rrweb/2" ||
		c.Attributes["ouo.replay.masked"] != true || c.Attributes["enduser.id"] != "user-42" {
		t.Errorf("manifest %+v", m)
	}
	ch, err := f.muninn.Chunk(ctx, proj, sess, replay, stream, 0)
	if err != nil || string(ch.Body) != chunkBody || ch.Format != "rrweb/2" {
		t.Errorf("chunk %+v %v", ch, err)
	}
	if _, err := f.muninn.ListReplays(ctx, proj, "ffffffffffffffffffffffffffffffff"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown session: %v", err)
	}
}

func TestValidation(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	var bad *BadRequestError
	for name, err := range map[string]error{
		"session":   func() error { _, err := f.loki.SessionEvents(ctx, proj, "not-hex", TimeRange{}); return err }(),
		"project":   func() error { _, err := f.loki.SessionEvents(ctx, `x"}`, sess, TimeRange{}); return err }(),
		"list proj": func() error { _, err := f.loki.ListSessions(ctx, SessionQuery{Project: "A B"}); return err }(),
		"replays":   func() error { _, err := f.muninn.ListReplays(ctx, proj, "../x"); return err }(),
		"stream":    func() error { _, err := f.muninn.Chunk(ctx, proj, sess, replay, "zz", 0); return err }(),
		"sequence":  func() error { _, err := f.muninn.Chunk(ctx, proj, sess, replay, stream, -1); return err }(),
		"replay":    func() error { _, err := f.muninn.Manifest(ctx, proj, sess, "../x"); return err }(),
		"range order": func() error {
			_, err := f.loki.ListSessions(ctx, SessionQuery{TimeRange: TimeRange{From: time.Unix(10, 0), To: time.Unix(5, 0)}})
			return err
		}(),
		"range too long": func() error {
			_, err := f.loki.ListSessions(ctx, SessionQuery{TimeRange: TimeRange{From: time.Unix(0, 0), To: time.Unix(31*86400, 0)}})
			return err
		}(),
	} {
		if !errors.As(err, &bad) {
			t.Errorf("%s: got %v, want a BadRequestError", name, err)
		}
	}
	if len(f.fl.queries) != 0 || f.fm.calls != 0 {
		t.Errorf("a store was called with invalid input: loki %v, muninn %d calls", f.fl.queries, f.fm.calls)
	}
}

func TestQueries(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.loki.ListSessions(ctx, SessionQuery{Project: proj}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.loki.ListSessions(ctx, SessionQuery{}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.loki.SessionEvents(ctx, proj, sess, TimeRange{}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		`{ouo_project_id="demo", event_name!~"ouo[.]replay[.]chunk"} | session_id != ""`,
		`sum by (ouo_project_id, session_id) (count_over_time({ouo_project_id="demo", event_name="ouo.replay.chunk"} [86400s]))`,
		`{ouo_project_id=~".+", event_name!~"ouo[.]replay[.]chunk"} | session_id != ""`,
		`sum by (ouo_project_id, session_id) (count_over_time({ouo_project_id=~".+", event_name="ouo.replay.chunk"} [86400s]))`,
		`{ouo_project_id="demo", event_name!~"ouo[.]replay[.]chunk"} | session_id="` + sess + `"`,
	}
	if strings.Join(f.fl.queries, "\n") != strings.Join(want, "\n") {
		t.Errorf("queries:\n%s\nwant:\n%s", strings.Join(f.fl.queries, "\n"), strings.Join(want, "\n"))
	}
}

func TestErrors(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.loki.SessionEvents(ctx, proj, "ffffffffffffffffffffffffffffffff", TimeRange{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown session: %v", err)
	}
	if _, err := f.muninn.Manifest(ctx, proj, sess, "cccccccccccccccccccccccccccccccc"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown replay: %v", err)
	}
	// A wrong read token is a backend error, not a not-found, and its public message
	// carries no URL.
	f.muninn.ReadToken = "wrong"
	var be *BackendError
	if _, err := f.muninn.Manifest(ctx, proj, sess, replay); !errors.As(err, &be) || be.Public() != "muninn could not be read" {
		t.Errorf("wrong token: %v", err)
	}
	f.loki.URL = "http://127.0.0.1:1"
	if _, err := f.loki.ListSessions(ctx, SessionQuery{}); !errors.As(err, &be) || be.Backend != "loki" || strings.Contains(be.Public(), "127.0.0.1") {
		t.Errorf("loki down: %v", err)
	}
}

func TestQueryRangeLimit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.loki.QueryRange(ctx, `{ouo_project_id="demo"}`, time.Unix(0, 0), time.Unix(10, 0), 0, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.loki.QueryRange(ctx, `{ouo_project_id="demo"}`, time.Unix(0, 0), time.Unix(10, 0), 7, false); err != nil {
		t.Fatal(err)
	}
	if strings.Join(f.fl.limits, ",") != "5000,7" {
		t.Errorf("limits sent: %v, want 5000 for 0, then 7", f.fl.limits)
	}
}
