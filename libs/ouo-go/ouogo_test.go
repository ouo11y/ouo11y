package ouogo

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
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
}

func (f *fakeLoki) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("query")
	f.queries = append(f.queries, q)
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
		_, _ = w.Write(gz([]byte(`{"session_id":"` + sess + `","replay_id":"` + replay + `","project":"demo","state":"complete","streams":[{"stream_id":"` + stream + `","state":"complete","end":null,"missing":[],"chunks":[{"sequence":0,"keyframe":true,"format":"rrweb/2","encoding":"gzip","attributes":{"ouo.replay.masked":true},"path":"/x"}]}]}`)))
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

func newClient(t *testing.T) (*Client, *fakeLoki, *fakeMuninn) {
	t.Helper()
	fl, fm := &fakeLoki{}, &fakeMuninn{}
	ls, ms := httptest.NewServer(fl), httptest.NewServer(fm)
	t.Cleanup(ls.Close)
	t.Cleanup(ms.Close)
	now := time.Unix(1794400010, 0)
	return &Client{
		Loki:   &Loki{URL: ls.URL},
		Muninn: &Muninn{URL: ms.URL, ReadToken: readTok},
		Now:    func() time.Time { return now },
	}, fl, fm
}

func TestResolve(t *testing.T) {
	cfg := ClearanceConfig{Users: map[string]Level{"alice": C4, "mallory": None}}
	cases := []struct {
		login, role string
		want        Level
	}{
		{"bob", "Viewer", C1},
		{"bob", "Editor", C3},
		{"bob", "Admin", C5},
		{"bob", "None", None},
		{"bob", "", None},
		{"bob", "Superuser", None},
		{"alice", "Viewer", C4},    // user entry wins, upward
		{"mallory", "Admin", None}, // and downward
	}
	for _, c := range cases {
		if got := Resolve(cfg, c.login, c.role).Level; got != c.want {
			t.Errorf("Resolve(%q, %q) = %v, want %v", c.login, c.role, got, c.want)
		}
	}
	// An explicit roles map replaces the default one: deny by default for roles it lacks.
	if got := Resolve(ClearanceConfig{Roles: map[string]Level{"Admin": C2}}, "x", "Viewer").Level; got != None {
		t.Errorf("Viewer with a roles map that omits it = %v, want c0", got)
	}
}

func TestLevelJSON(t *testing.T) {
	var cfg ClearanceConfig
	if err := json.Unmarshal([]byte(`{"roles":{"Viewer":"c2","Editor":4},"users":{"a":"C5"}}`), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Roles["Viewer"] != C2 || cfg.Roles["Editor"] != C4 || cfg.Users["a"] != C5 {
		t.Fatalf("got %+v", cfg)
	}
	for _, bad := range []string{`{"roles":{"Viewer":6}}`, `{"roles":{"Viewer":"admin"}}`, `{"roles":{"Viewer":-1}}`} {
		if err := json.Unmarshal([]byte(bad), &cfg); err == nil {
			t.Errorf("%s: want an error", bad)
		}
	}
}

// TestLevelsAgainstFields is the Clearance table as a test: for each level, which fields of
// the BFF's answers are present. A change to `levels` must change this table.
func TestLevelsAgainstFields(t *testing.T) {
	type seen struct {
		list, timeline, attributes, body, identityAttr, user, replays, manifest, chunk bool
	}
	want := map[Level]seen{
		None: {},
		C1:   {list: true, timeline: true},
		C2:   {list: true, timeline: true, attributes: true, body: true},
		C3:   {list: true, timeline: true, attributes: true, body: true, replays: true, manifest: true, chunk: true},
		C4:   {list: true, timeline: true, attributes: true, body: true, identityAttr: true, user: true, replays: true, manifest: true, chunk: true},
		C5:   {list: true, timeline: true, attributes: true, body: true, identityAttr: true, user: true, replays: true, manifest: true, chunk: true},
	}
	ctx := context.Background()
	for lv := None; lv <= C5; lv++ {
		c, _, fm := newClient(t)
		cl := Clearance{Login: "u", Role: "Viewer", Level: lv}
		var got seen

		list, err := c.ListSessions(ctx, cl, SessionQuery{})
		if err == nil {
			got.list = len(list.Sessions) == 1
			got.user = list.Sessions[0].User == "user-42"
			if !list.Sessions[0].HasReplay || list.Sessions[0].EventCount != 3 || list.Sessions[0].ErrorCount != 1 {
				t.Errorf("%v: list summary %+v", lv, list.Sessions[0])
			}
		} else if !errors.Is(err, ErrForbidden) {
			t.Fatalf("%v: list: %v", lv, err)
		}

		d, err := c.GetSession(ctx, cl, proj, sess, TimeRange{})
		if err == nil {
			got.timeline = len(d.Events) == 3 && d.Events[1].Name == "browser.navigation" && d.Events[1].ViewID == "v1"
			nav := d.Events[1].Attributes
			got.attributes = nav["browser_document_url_full"] != "" && nav["user_agent_original"] != ""
			got.identityAttr = nav["enduser_id"] != ""
			got.body = d.Events[2].Body == "stack body"
			got.replays = d.Replays != nil && len(d.Replays) == 1
			if got.user != (d.Session.User == "user-42") {
				t.Errorf("%v: list and detail disagree on the user", lv)
			}
			// Core fields never appear twice, as attributes.
			if _, dup := nav["session_id"]; dup {
				t.Errorf("%v: core key in attributes", lv)
			}
		} else if !errors.Is(err, ErrForbidden) {
			t.Fatalf("%v: session: %v", lv, err)
		}

		before := fm.calls
		m, err := c.GetManifest(ctx, cl, proj, sess, replay)
		if err == nil {
			got.manifest = len(m.Streams) == 1 && m.Streams[0].Chunks[0].Keyframe
		} else if !errors.Is(err, ErrForbidden) {
			t.Fatalf("%v: manifest: %v", lv, err)
		}
		ch, err := c.GetChunk(ctx, cl, proj, sess, replay, stream, 0)
		if err == nil {
			got.chunk = string(ch.Body) == chunkBody && ch.Format == "rrweb/2"
		} else if !errors.Is(err, ErrForbidden) {
			t.Fatalf("%v: chunk: %v", lv, err)
		}
		if !lv.Can().Replay && fm.calls != before {
			t.Errorf("%v: Muninn was called without replay clearance", lv)
		}

		if got != want[lv] {
			t.Errorf("%v: saw %+v\n          want %+v", lv, got, want[lv])
		}
		if lv >= C1 && d != nil {
			wantRedacted := len(list.Redacted)
			if len(d.Redacted) != wantRedacted {
				t.Errorf("%v: redacted lists differ: %v vs %v", lv, list.Redacted, d.Redacted)
			}
		}
	}
}

func TestRedactedGroups(t *testing.T) {
	want := map[Level]string{
		None: "attributes,replay,identity", C1: "attributes,replay,identity", C2: "replay,identity",
		C3: "identity", C4: "", C5: "",
	}
	for lv, w := range want {
		if got := strings.Join(Clearance{Level: lv}.redactedGroups(), ","); got != w {
			t.Errorf("%v: %q, want %q", lv, got, w)
		}
	}
}

func TestValidation(t *testing.T) {
	c, fl, _ := newClient(t)
	ctx := context.Background()
	cl := Clearance{Level: C5}
	var bad *BadRequestError
	for name, err := range map[string]error{
		"session":   func() error { _, err := c.GetSession(ctx, cl, proj, "not-hex", TimeRange{}); return err }(),
		"project":   func() error { _, err := c.GetSession(ctx, cl, `x"}`, sess, TimeRange{}); return err }(),
		"list proj": func() error { _, err := c.ListSessions(ctx, cl, SessionQuery{Project: "A B"}); return err }(),
		"stream":    func() error { _, err := c.GetChunk(ctx, cl, proj, sess, replay, "zz", 0); return err }(),
		"sequence":  func() error { _, err := c.GetChunk(ctx, cl, proj, sess, replay, stream, -1); return err }(),
		"replay":    func() error { _, err := c.GetManifest(ctx, cl, proj, sess, "../x"); return err }(),
		"range order": func() error {
			_, err := c.ListSessions(ctx, cl, SessionQuery{TimeRange: TimeRange{From: time.Unix(10, 0), To: time.Unix(5, 0)}})
			return err
		}(),
	} {
		if !errors.As(err, &bad) {
			t.Errorf("%s: got %v, want a BadRequestError", name, err)
		}
	}
	if len(fl.queries) != 0 {
		t.Errorf("Loki was queried with invalid input: %v", fl.queries)
	}
}

func TestQueries(t *testing.T) {
	c, fl, _ := newClient(t)
	ctx := context.Background()
	if _, err := c.ListSessions(ctx, Clearance{Level: C1}, SessionQuery{Project: proj}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetSession(ctx, Clearance{Level: C1}, proj, sess, TimeRange{}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		`{ouo_project_id="demo", event_name!~"ouo[.]replay[.]chunk"} | session_id != ""`,
		`sum by (ouo_project_id, session_id) (count_over_time({ouo_project_id="demo", event_name="ouo.replay.chunk"} [86400s]))`,
		`{ouo_project_id="demo", event_name!~"ouo[.]replay[.]chunk"} | session_id="` + sess + `"`,
	}
	if strings.Join(fl.queries, "\n") != strings.Join(want, "\n") {
		t.Errorf("queries:\n%s\nwant:\n%s", strings.Join(fl.queries, "\n"), strings.Join(want, "\n"))
	}
}

func TestNotFound(t *testing.T) {
	c, _, _ := newClient(t)
	ctx := context.Background()
	if _, err := c.GetSession(ctx, Clearance{Level: C5}, proj, "ffffffffffffffffffffffffffffffff", TimeRange{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown session: %v", err)
	}
	if _, err := c.GetManifest(ctx, Clearance{Level: C5}, proj, sess, "cccccccccccccccccccccccccccccccc"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown replay: %v", err)
	}
	// A wrong read token is a backend error, not a not-found.
	c.Muninn.ReadToken = "wrong"
	var be *BackendError
	if _, err := c.GetManifest(ctx, Clearance{Level: C5}, proj, sess, replay); !errors.As(err, &be) {
		t.Errorf("wrong token: %v", err)
	}
}
