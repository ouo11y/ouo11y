package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/loki"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/tempo"
)

// Three sessions over two projects and three apps (JUHI gap R1):
//
//	shop-web-1  project shop, app shop-web, web, healthy
//	shop-ios-1  project shop, app shop-ios, mobile, crashed
//	bank-web-1  project bank, app bank-web, web, errored
var scopeBase = time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)

func scopeEvents() []session.Event {
	ev := func(off time.Duration, name, id, project, service, platform string, attrs map[string]string) session.Event {
		if attrs == nil {
			attrs = map[string]string{}
		}
		attrs["ouo_project_id"] = project
		return session.Event{TS: scopeBase.Add(off), Name: name, SessionID: id, ProjectID: project, ServiceName: service,
			ServiceVersion: "1.0.0", Platform: platform, UserID: "u-" + id, Attrs: attrs}
	}
	return []session.Event{
		ev(0, "session.start", "shop-web-1", "shop", "shop-web", "web", nil),
		ev(time.Second, "navigation", "shop-web-1", "shop", "shop-web", "web", map[string]string{"url_path": "/"}),
		ev(2*time.Second, "session.start", "shop-ios-1", "shop", "shop-ios", "mobile", nil),
		ev(3*time.Second, "exception", "shop-ios-1", "shop", "shop-ios", "mobile", map[string]string{"ouo_exception_fatal": "true"}),
		ev(4*time.Second, "session.start", "bank-web-1", "bank", "bank-web", "web", nil),
		ev(5*time.Second, "exception", "bank-web-1", "bank", "bank-web", "web", nil),
	}
}

// countingEvents adds the CountsBy capability GET /v1/projects needs.
type countingEvents struct {
	*fakeEvents
	groups []loki.GroupCount
	by     []string
	query  string
	ranges [][2]time.Time
}

func (c *countingEvents) CountsBy(ctx context.Context, query string, by []string, start, end time.Time) ([]loki.GroupCount, error) {
	c.query, c.by = query, by
	c.ranges = append(c.ranges, [2]time.Time{start, end})
	return c.groups, nil
}

func newScopeServer(t *testing.T) (*httptest.Server, *countingEvents, *replay.FS) {
	t.Helper()
	ce := &countingEvents{fakeEvents: &fakeEvents{events: scopeEvents()}}
	store, err := replay.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := scopeBase.Add(10 * time.Minute)
	srv := New(ce, &fakeTraces{traces: map[string][]tempo.Trace{"bank-web-1": {{TraceID: "abc"}}}}, store, Options{Now: func() time.Time { return now }})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, ce, store
}

func TestListSessionsScope(t *testing.T) {
	ts, ce, _ := newScopeServer(t)
	ids := func(query string) []string {
		t.Helper()
		var lr listResponse
		if code := getJSON(t, ts.URL+"/v1/sessions?from=now-1h"+query, &lr); code != 200 {
			t.Fatalf("%s: %d", query, code)
		}
		var out []string
		for _, s := range lr.Sessions {
			out = append(out, s.ProjectID+"/"+s.ServiceName+"/"+s.SessionID)
		}
		return out
	}
	if got := ids(""); len(got) != 3 {
		t.Fatalf("all projects: %v", got)
	}
	if got := strings.Join(ids("&project=shop"), ","); got != "shop/shop-ios/shop-ios-1,shop/shop-web/shop-web-1" {
		t.Fatalf("project=shop: %s", got)
	}
	if f := ce.filters[len(ce.filters)-1]; f.Project != "shop" || f.Service != "" {
		t.Fatalf("loki filters: %+v", f)
	}
	if got := strings.Join(ids("&project=shop&service=shop-web"), ","); got != "shop/shop-web/shop-web-1" {
		t.Fatalf("project=shop service=shop-web: %s", got)
	}
	if got := ids("&project=bank&service=shop-web"); len(got) != 0 {
		t.Fatalf("app of another project: %v", got)
	}
	if got := strings.Join(ids("&service=bank-web"), ","); got != "bank/bank-web/bank-web-1" {
		t.Fatalf("service only: %s", got)
	}
	var e map[string]string
	if code := getJSON(t, ts.URL+"/v1/sessions?project=Not%20Valid", &e); code != 400 || e["error"] != "invalid project id" {
		t.Fatalf("invalid project: %d %v", code, e)
	}
}

func TestStatsHealthScopeAndApps(t *testing.T) {
	ts, _, _ := newScopeServer(t)
	var st statsResponse
	if code := getJSON(t, ts.URL+"/v1/stats/health?from=now-1h", &st); code != 200 {
		t.Fatalf("stats: %d", code)
	}
	if st.Totals.Total != 3 || len(st.Buckets) != 3 || len(st.Apps) != 3 {
		t.Fatalf("all: %+v", st)
	}
	// Buckets sort by project first.
	if st.Buckets[0].ProjectID != "bank" || st.Buckets[1].ProjectID != "shop" || st.Buckets[1].Platform != "mobile" {
		t.Fatalf("bucket order: %+v", st.Buckets)
	}
	want := []struct {
		project, service, platform       string
		total, healthy, errored, crashed int
	}{
		{"bank", "bank-web", "web", 1, 0, 1, 0},
		{"shop", "shop-ios", "mobile", 1, 0, 0, 1},
		{"shop", "shop-web", "web", 1, 1, 0, 0},
	}
	for i, w := range want {
		a := st.Apps[i]
		if a.ProjectID != w.project || a.ServiceName != w.service || len(a.Platforms) != 1 || a.Platforms[0] != w.platform ||
			a.Total != w.total || a.Healthy != w.healthy || a.Errored != w.errored || a.Crashed != w.crashed {
			t.Fatalf("app %d: %+v, want %+v", i, a, w)
		}
	}
	if code := getJSON(t, ts.URL+"/v1/stats/health?from=now-1h&project=shop", &st); code != 200 || st.Totals.Total != 2 || st.Totals.CrashedPct != 50 || len(st.Apps) != 2 {
		t.Fatalf("project=shop: %+v", st)
	}
	if code := getJSON(t, ts.URL+"/v1/stats/health?from=now-1h&project=shop&service=shop-ios", &st); code != 200 || st.Totals.Total != 1 || st.Totals.CrashedPct != 100 {
		t.Fatalf("project=shop service=shop-ios: %+v", st)
	}
	var e map[string]string
	if code := getJSON(t, ts.URL+"/v1/stats/health?project=..", &e); code != 400 {
		t.Fatalf("invalid project: %d %v", code, e)
	}
}

func TestSessionReadsScope(t *testing.T) {
	ts, _, _ := newScopeServer(t)
	for _, path := range []string{"", "/traces", "/logs", "/vitals"} {
		url := ts.URL + "/v1/sessions/bank-web-1" + path
		if code := getJSON(t, url, nil); code != 200 {
			t.Errorf("%s unscoped: %d", path, code)
		}
		if code := getJSON(t, url+"?project=bank&service=bank-web", nil); code != 200 {
			t.Errorf("%s in scope: %d", path, code)
		}
		if code := getJSON(t, url+"?project=shop", nil); code != 404 {
			t.Errorf("%s other project: %d, want 404", path, code)
		}
		if code := getJSON(t, url+"?service=shop-web", nil); code != 404 {
			t.Errorf("%s other app: %d, want 404", path, code)
		}
		if code := getJSON(t, url+"?project=BAD!", nil); code != 400 {
			t.Errorf("%s invalid project: %d, want 400", path, code)
		}
	}
	var d detailResponse
	if code := getJSON(t, ts.URL+"/v1/sessions/bank-web-1?project=bank", &d); code != 200 || d.ProjectID != "bank" || d.ServiceName != "bank-web" {
		t.Fatalf("detail project: %d %+v", code, d.Record)
	}
}

func TestReplayReadsScope(t *testing.T) {
	ts, _, _ := newScopeServer(t)
	id := "bank-web-1"
	body, _ := json.Marshal(map[string]any{"session_id": id, "seq": 0, "started_at": 1000, "ended_at": 2000,
		"events": []any{map[string]any{"type": 4, "data": map[string]any{"href": "http://x/"}, "timestamp": 1000}}})
	// postChunk sends the collector's project header (testProject).
	if resp := postChunk(t, ts.URL+"/v1/replay/chunks", bytes.NewReader(body)); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("post: %d", resp.StatusCode)
	}
	for _, path := range []string{"/replay", "/replay/events"} {
		url := ts.URL + "/v1/sessions/" + id + path
		for query, want := range map[string]int{"": 200, "?project=" + testProject: 200, "?project=" + otherProject: 404, "?project=no%2Fslash": 400} {
			if code := getJSON(t, url+query, nil); code != want {
				t.Errorf("%s%s: %d, want %d", path, query, code, want)
			}
		}
	}
	// The kind check still answers 409 inside the scope.
	if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay/frames?project="+testProject, nil); code != 409 {
		t.Errorf("frames of an rrweb replay: %d, want 409", code)
	}
	// A missing replay is still 404 with a scope.
	if code := getJSON(t, ts.URL+"/v1/sessions/nope/replay/events?project="+testProject, nil); code != 404 {
		t.Errorf("missing replay: %d", code)
	}
}

func TestListProjects(t *testing.T) {
	ts, ce, _ := newScopeServer(t)
	ce.groups = []loki.GroupCount{
		{Labels: map[string]string{"ouo_project_id": "shop", "service_name": "shop-web", "ouo_platform": "web"}, Count: 7},
		{Labels: map[string]string{"ouo_project_id": "shop", "service_name": "shop-rn", "ouo_platform": "mobile"}, Count: 2},
		{Labels: map[string]string{"ouo_project_id": "shop", "service_name": "shop-rn", "ouo_platform": "web"}, Count: 1},
		{Labels: map[string]string{"ouo_project_id": "bank", "service_name": "bank-web", "ouo_platform": "web"}, Count: 4},
		{Labels: map[string]string{"ouo_project_id": "", "service_name": "legacy", "ouo_platform": "web"}, Count: 3},
		{Labels: map[string]string{"ouo_project_id": "bank", "service_name": "bank-web", "ouo_platform": "web"}, Count: 0},
	}
	var pr projectsResponse
	if code := getJSON(t, ts.URL+"/v1/projects", &pr); code != 200 {
		t.Fatalf("projects: %d", code)
	}
	if ce.query != projectsQuery || strings.Join(ce.by, ",") != "ouo_project_id,service_name,ouo_platform" {
		t.Fatalf("loki query %s by %v", ce.query, ce.by)
	}
	// now is scopeBase+10m, on a minute: the default range is exactly 7 days.
	if r := ce.ranges[0]; r[1].Sub(r[0]) != defaultProjectsRange || !r[1].Equal(scopeBase.Add(10*time.Minute)) {
		t.Fatalf("default range %v .. %v", r[0], r[1])
	}
	// from rounds down and to rounds up to the minute: a session that started
	// seconds ago is still counted.
	getJSON(t, ts.URL+"/v1/projects?from="+scopeBase.Add(90*time.Second).Format(time.RFC3339)+"&to="+scopeBase.Add(150*time.Second).Format(time.RFC3339), nil)
	if r := ce.ranges[1]; !r[0].Equal(scopeBase.Add(time.Minute)) || !r[1].Equal(scopeBase.Add(3*time.Minute)) {
		t.Fatalf("rounded range %v .. %v", r[0], r[1])
	}
	b, _ := json.Marshal(pr.Projects)
	want := `[{"project_id":"bank","sessions":4,"apps":[{"service_name":"bank-web","platforms":["web"],"sessions":4}]},` +
		`{"project_id":"shop","sessions":10,"apps":[{"service_name":"shop-rn","platforms":["mobile","web"],"sessions":3},{"service_name":"shop-web","platforms":["web"],"sessions":7}]}]`
	if string(b) != want {
		t.Fatalf("projects\n got %s\nwant %s", b, want)
	}
	if pr.Unscoped != 3 {
		t.Fatalf("unscoped %d", pr.Unscoped)
	}
	if code := getJSON(t, ts.URL+"/v1/projects?from=now-31d", nil); code != 400 {
		t.Fatalf("31d range: %d", code)
	}
	if code := getJSON(t, ts.URL+"/v1/projects?from=garbage", nil); code != 400 {
		t.Fatalf("bad from: %d", code)
	}
	ce.groups = nil
	if code := getJSON(t, ts.URL+"/v1/projects?from=now-1h", &pr); code != 200 || pr.Projects == nil || len(pr.Projects) != 0 {
		t.Fatalf("empty: %d %+v", code, pr)
	}
}

func TestListProjectsNeedsLoki(t *testing.T) {
	ts, _, _ := newTestServer(t) // fakeEvents has no CountsBy
	if code := getJSON(t, ts.URL+"/v1/projects", nil); code != http.StatusNotImplemented {
		t.Fatalf("got %d, want 501", code)
	}
}

func TestListProjectsReadToken(t *testing.T) {
	ts, _, _ := newTestServerWith(t, func(o *Options) { o.ReadToken = readToken })
	if code := getJSON(t, ts.URL+"/v1/projects", nil); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d, want 401", code)
	}
}
