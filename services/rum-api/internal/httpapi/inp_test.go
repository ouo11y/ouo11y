package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/vitals"
)

func inpEvent(sid string, value, target, path string) session.Event {
	return session.Event{TS: fnow.Add(-10 * time.Minute), Name: "web_vital", SessionID: sid, Attrs: map[string]string{
		vitals.AttrName: "INP", vitals.AttrID: "v1", vitals.AttrValue: value, vitals.AttrTarget: target, vitals.AttrPath: path,
	}}
}

func newINPServer(t *testing.T) (*httptest.Server, *funnelEvents) {
	t.Helper()
	fe := &funnelEvents{events: []session.Event{
		inpEvent("1", "520", "button#save", "/patients/1"),
		inpEvent("2", "260", "button#save", "/patients/1"),
		inpEvent("3", "64", "a#home", "/"),
		inpEvent("4", "130", "input#q", "/search"),
	}}
	store, err := replay.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New(fe, &fakeTraces{}, store, Options{Now: func() time.Time { return fnow }}).Handler())
	t.Cleanup(ts.Close)
	return ts, fe
}

func TestINPTargets(t *testing.T) {
	ts, fe := newINPServer(t)
	var r inpTargetsResponse
	if code := getFunnelJSON(t, ts.URL+"/v1/vitals/inp/targets?from=now-1h&to=now&service=web-store&environment=local&release=1.2.0&project=juhi&page=/patients/:id&limit=2", &r); code != 200 {
		t.Fatalf("status %d", code)
	}
	if r.Total != 3 || r.PageViews != 4 || len(r.Groups) != 2 {
		t.Fatalf("response %+v", r)
	}
	if g := r.Groups[0]; g.Target != "button#save" || g.P75Ms != 520 || g.Count != 2 || g.Rating != "poor" {
		t.Errorf("slowest %+v", g)
	}
	if !r.To.Equal(fnow) || !r.From.Equal(fnow.Add(-time.Hour)) {
		t.Errorf("range %v %v", r.From, r.To)
	}
	q := fe.queries[0]
	for _, want := range []string{
		`service_name="web-store"`, `event_name="web_vital"`, `deployment_environment_name="local"`, `ouo_project_id="juhi"`,
		`| service_version="1.2.0"`, `| ouo_web_vital_name="INP"`, `| (app_screen_name="/patients/:id" or url_path="/patients/:id")`,
	} {
		if !strings.Contains(q, want) {
			t.Errorf("query %s lacks %s", q, want)
		}
	}
}

func TestINPTargetsEmptyAndBadRequests(t *testing.T) {
	ts, fe := newINPServer(t)
	fe.events = nil
	var r inpTargetsResponse
	if code := getFunnelJSON(t, ts.URL+"/v1/vitals/inp/targets", &r); code != 200 || r.Groups == nil || len(r.Groups) != 0 {
		t.Fatalf("empty: %d %+v", code, r)
	}
	for _, q := range []string{"limit=0", "limit=x", "project=a%20b", "from=now-40d", "from=yesterday"} {
		resp, err := http.Get(ts.URL + "/v1/vitals/inp/targets?" + q)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status %d", q, resp.StatusCode)
		}
	}
}
