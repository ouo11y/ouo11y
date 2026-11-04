package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/funnel"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/loki"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// funnelEvents answers each step query with the events whose name matches the
// query's event_name matcher, like Loki would (label filters are left to the
// engine, which re-checks every condition), and records the queries. With
// capAt > 0 it returns at most capAt events per query and reports the cut.
type funnelEvents struct {
	events  []session.Event
	mu      sync.Mutex
	queries []string
	counts  []string
	capAt   int
}

var eventNameMatcher = regexp.MustCompile(`event_name(=~|=)("(?:[^"\\]|\\.)*")`)

func (f *funnelEvents) EventsQueryCapped(ctx context.Context, q string, start, end time.Time) ([]session.Event, bool, error) {
	evs, err := f.EventsQuery(ctx, q, start, end)
	if f.capAt > 0 && len(evs) > f.capAt {
		return evs[:f.capAt], true, err
	}
	return evs, false, err
}

func (f *funnelEvents) Events(ctx context.Context, fl loki.Filters, start, end time.Time) ([]session.Event, error) {
	return nil, nil
}
func (f *funnelEvents) Ready(context.Context) error { return nil }
func (f *funnelEvents) EventsQuery(ctx context.Context, q string, start, end time.Time) ([]session.Event, error) {
	f.mu.Lock()
	f.queries = append(f.queries, q)
	f.mu.Unlock()
	m := eventNameMatcher.FindStringSubmatch(q) // the selector's comes first
	if m == nil {
		return nil, fmt.Errorf("no event_name matcher in %s", q)
	}
	v, err := strconv.Unquote(m[2])
	if err != nil {
		return nil, err
	}
	match := func(n string) bool { return n == v }
	if m[1] == "=~" {
		re := regexp.MustCompile("^(?:" + v + ")$")
		match = re.MatchString
	}
	var out []session.Event
	for _, ev := range f.events {
		if match(ev.Name) && !ev.TS.Before(start) && !ev.TS.After(end) {
			out = append(out, ev)
		}
	}
	session.SortEvents(out)
	return out, nil
}
func (f *funnelEvents) Counts(ctx context.Context, q, by string, start, end time.Time) (map[string]int, error) {
	f.mu.Lock()
	f.counts = append(f.counts, q)
	f.mu.Unlock()
	out := map[string]int{}
	for _, ev := range f.events {
		if by == "url_path" && ev.Name == "navigation" {
			out[ev.Attrs["url_path"]]++
		}
		if by == "event_name" && ev.Name != "navigation" {
			out[ev.Name]++
		}
	}
	return out, nil
}

var fnow = time.Date(2026, 10, 24, 13, 0, 0, 0, time.UTC)

func fev(sid string, min int, name, path string) session.Event {
	ev := session.Event{TS: fnow.Add(time.Duration(min-60) * time.Minute), Name: name, SessionID: sid, UserID: "u" + sid, Attrs: map[string]string{}}
	if path != "" {
		ev.Attrs["url_path"] = path
	}
	return ev
}

func newFunnelServer(t *testing.T, readToken string) (*httptest.Server, *funnelEvents, *replay.FS) {
	t.Helper()
	fe := &funnelEvents{events: []session.Event{
		fev("1", 0, "navigation", "/"), fev("1", 1, "navigation", "/products/7"), fev("1", 2, "add_to_cart", ""), fev("1", 3, "order_paid", ""),
		fev("2", 5, "navigation", "/"), fev("2", 6, "navigation", "/products/2"), fev("2", 7, "add_to_cart", ""),
		fev("3", 10, "navigation", "/"), fev("3", 12, "navigation", "/products/3"),
		fev("4", 20, "navigation", "/"),
		// Session 5 entered before the range (minute -30, outside [now-1h, now]).
		fev("5", -30, "navigation", "/"), fev("5", 25, "navigation", "/products/5"),
	}}
	store, err := replay.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := New(fe, &fakeTraces{}, store, Options{Now: func() time.Time { return fnow }, ReadToken: readToken, FunnelCacheTTL: time.Minute})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, fe, store
}

const shopBody = `{"steps":[{"kind":"page","value":"/"},{"kind":"page","match":"prefix","value":"/products/"},{"kind":"event","value":"add_to_cart"},{"kind":"event","value":"order_paid"}],
	"from":"now-1h","to":"now","filters":{"service":"tiny-shop-web","environment":"local","release":"1.0.0","project":"demo"}}`

func postFunnel(t *testing.T, ts *httptest.Server, body string, headers ...string) (*http.Response, funnelResponse) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/funnels/query", strings.NewReader(body))
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var fr funnelResponse
	json.NewDecoder(resp.Body).Decode(&fr)
	return resp, fr
}

func TestFunnelQuery(t *testing.T) {
	ts, fe, _ := newFunnelServer(t, "")
	resp, fr := postFunnel(t, ts, shopBody)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	got := []int{}
	for _, s := range fr.Steps {
		got = append(got, s.Sessions)
	}
	if want := []int{4, 3, 2, 1}; !equalInts(got, want) {
		t.Fatalf("sessions per step %v, want %v", got, want)
	}
	if fr.Steps[1].DroppedOff != 1 || fr.Steps[1].ConversionFromFirst != 75 || fr.Users != 4 {
		t.Errorf("step 2 %+v users %d", fr.Steps[1], fr.Users)
	}
	// 1, 1, 2 minutes from / to the product page: median and p75.
	if *fr.Steps[1].MedianMs != 60000 || *fr.Steps[1].P75Ms != 120000 {
		t.Errorf("times %d %d", *fr.Steps[1].MedianMs, *fr.Steps[1].P75Ms)
	}
	// Pages, events and the default failure event (exception).
	if len(fe.queries) != 3 {
		t.Fatalf("queries %v", fe.queries)
	}
	var nav, ev, fail string
	for _, q := range fe.queries {
		switch {
		case strings.Contains(q, `event_name="navigation"`):
			nav = q
		case strings.Contains(q, `event_name="exception"`):
			fail = q
		default:
			ev = q
		}
	}
	for _, want := range []string{`service_name="tiny-shop-web"`, `deployment_environment_name="local"`, `ouo_project_id="demo"`, `| service_version="1.0.0"`} {
		if !strings.Contains(nav, want) || !strings.Contains(ev, want) || !strings.Contains(fail, want) {
			t.Errorf("queries miss %s:\n%s\n%s\n%s", want, nav, ev, fail)
		}
	}
	if !strings.HasSuffix(nav, `| url_path=~"/|/products/.*"`) || !strings.HasSuffix(ev, `event_name=~"add_to_cart|order_paid", ouo_project_id="demo"} | service_version="1.0.0"`) {
		t.Errorf("step filters:\n%s\n%s", nav, ev)
	}
	if fr.Failure == nil || fr.Failure.Value != "exception" || fr.Truncated || len(fr.TruncatedReads) != 0 {
		t.Errorf("failure %+v truncated %v %v", fr.Failure, fr.Truncated, fr.TruncatedReads)
	}
	// Cached: a second identical query reads Loki no more.
	postFunnel(t, ts, shopBody)
	if len(fe.queries) != 3 {
		t.Errorf("cache miss: %d queries", len(fe.queries))
	}
}

func TestFunnelQueryWithin(t *testing.T) {
	ts, _, _ := newFunnelServer(t, "")
	body := strings.Replace(shopBody, `"from"`, `"within":"90s","from"`, 1)
	_, fr := postFunnel(t, ts, body)
	// Within 90 s of step 1: session 1 reaches /products (1m), cart at 2m is out.
	if fr.Steps[1].Sessions != 2 || fr.Steps[2].Sessions != 0 || fr.Within == nil || *fr.Within != 90000 {
		t.Fatalf("got %+v within %v", fr.Steps, fr.Within)
	}
}

func TestFunnelQueryBadRequests(t *testing.T) {
	ts, _, _ := newFunnelServer(t, "")
	for _, body := range []string{
		`{`,
		`{"steps":[{"kind":"page","value":"/"}]}`,
		`{"steps":[{"kind":"click","value":"#buy"},{"kind":"page","value":"/"}]}`,
		`{"steps":[{"kind":"page","value":"/"},{"kind":"page","value":"/a"}],"within":"9w"}`,
		`{"steps":[{"kind":"page","value":"/"},{"kind":"page","value":"/a"}],"from":"now-40d"}`,
		`{"steps":[{"kind":"page","value":"/"},{"kind":"page","value":"/a"}],"filters":{"project":"Bad Id"}}`,
		`{"steps":[{"kind":"page","value":"/"},{"kind":"page","value":"/a"}],"unknown":1}`,
	} {
		if resp, _ := postFunnel(t, ts, body); resp.StatusCode != 400 {
			t.Errorf("%s: status %d", body, resp.StatusCode)
		}
	}
}

func TestFunnelReadToken(t *testing.T) {
	ts, _, _ := newFunnelServer(t, "secret")
	if resp, _ := postFunnel(t, ts, shopBody); resp.StatusCode != 401 {
		t.Fatalf("no token: %d", resp.StatusCode)
	}
	if resp, _ := postFunnel(t, ts, shopBody, "Authorization", "Bearer secret"); resp.StatusCode != 200 {
		t.Fatalf("token: %d", resp.StatusCode)
	}
}

func getFunnelJSON(t *testing.T, u string, v any) int {
	t.Helper()
	resp, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	json.NewDecoder(resp.Body).Decode(v)
	return resp.StatusCode
}

func TestFunnelDropped(t *testing.T) {
	ts, _, store := newFunnelServer(t, "")
	// Session 3 has a replay.
	if _, err := store.Put(context.Background(), "demo", []byte(`{"session_id":"3","seq":0,"started_at":1,"ended_at":2,"events":[{"type":4}]}`), nil); err != nil {
		t.Fatal(err)
	}
	steps := url.QueryEscape("page:/,page:/products/*,event:add_to_cart,event:order_paid")
	var dr droppedResponse
	if code := getFunnelJSON(t, ts.URL+"/v1/funnels/dropped?step=3&from=now-1h&steps="+steps, &dr); code != 200 {
		t.Fatalf("status %d", code)
	}
	if dr.Total != 1 || dr.Sessions[0].SessionID != "3" || !dr.Sessions[0].HasReplay || dr.Sessions[0].LastPath != "/products/3" {
		t.Fatalf("got %+v", dr)
	}
	// Pagination: step 3 drops -> 1; step 2 drops -> session 4; page size 1 at step 4.
	if getFunnelJSON(t, ts.URL+"/v1/funnels/dropped?step=4&limit=1&steps="+steps, &dr); dr.Total != 1 || dr.NextOffset != nil || dr.Sessions[0].SessionID != "2" {
		t.Fatalf("step 4: %+v", dr)
	}
	for _, bad := range []string{"step=1", "step=5", "step=x", "step=2&limit=0", "step=2&offset=-1"} {
		if code := getFunnelJSON(t, ts.URL+"/v1/funnels/dropped?steps="+steps+"&"+bad, &dr); code != 400 {
			t.Errorf("%s: %d", bad, code)
		}
	}
}

func TestFunnelDroppedPagination(t *testing.T) {
	ts, fe, _ := newFunnelServer(t, "")
	fe.events = nil
	for i := range 5 {
		fe.events = append(fe.events, fev(string(rune('a'+i)), i, "navigation", "/"))
	}
	steps := "page:/,page:/cart"
	var dr droppedResponse
	getFunnelJSON(t, ts.URL+"/v1/funnels/dropped?step=2&limit=2&steps="+url.QueryEscape(steps), &dr)
	if dr.Total != 5 || len(dr.Sessions) != 2 || dr.Sessions[0].SessionID != "e" || dr.NextOffset == nil || *dr.NextOffset != 2 {
		t.Fatalf("page 1 %+v", dr)
	}
	getFunnelJSON(t, ts.URL+"/v1/funnels/dropped?step=2&limit=2&offset=4&steps="+url.QueryEscape(steps), &dr)
	if len(dr.Sessions) != 1 || dr.Sessions[0].SessionID != "a" || dr.NextOffset != nil {
		t.Fatalf("page 3 %+v", dr)
	}
}

func TestFunnelSteps(t *testing.T) {
	ts, fe, _ := newFunnelServer(t, "")
	var sr suggestionsResponse
	if code := getFunnelJSON(t, ts.URL+"/v1/funnels/steps?service=tiny-shop-web", &sr); code != 200 {
		t.Fatalf("status %d", code)
	}
	if len(sr.Pages) == 0 || sr.Pages[0].Value != "/" || sr.Pages[0].Count != 5 {
		t.Fatalf("pages %+v", sr.Pages)
	}
	if len(sr.Events) != 2 || sr.Events[0].Value != "add_to_cart" {
		t.Fatalf("events %+v", sr.Events)
	}
	if !strings.Contains(strings.Join(fe.counts, "\n"), `| ouo_event_custom="true"`) {
		t.Errorf("custom filter missing: %v", fe.counts)
	}
	getFunnelJSON(t, ts.URL+"/v1/funnels/steps?q=prod", &sr)
	for _, p := range sr.Pages {
		if !strings.Contains(p.Value, "prod") {
			t.Errorf("q filter kept %s", p.Value)
		}
	}
}

func TestSplitSteps(t *testing.T) {
	got := splitSteps("page:/a,b,event:x,page:/c*")
	if strings.Join(got, "|") != "page:/a,b|event:x|page:/c*" {
		t.Fatalf("%v", got)
	}
	if _, err := funnel.ParseStep(got[0]); err != nil {
		t.Fatal(err)
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
