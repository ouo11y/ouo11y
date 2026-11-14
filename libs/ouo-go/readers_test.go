package ouogo

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Tests ported from rum-api (internal/funnel, internal/session, internal/tempo,
// internal/httpapi), plus the reader-level checks of this module: validation before any
// query, store errors kept out of answers, the LogQL and TraceQL sent.

var t0 = time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

func line(sid string, sec int, labels map[string]string) LokiLine {
	l := map[string]string{"session_id": sid, "user_id": "u-" + sid}
	for k, v := range labels {
		l[k] = v
	}
	return LokiLine{Time: t0.Add(time.Duration(sec) * time.Second), Labels: l}
}

// nav is a mobile (and MVP web) navigation: event "navigation" with url.path.
func nav(sid string, sec int, path string) LokiLine {
	return line(sid, sec, map[string]string{"event_name": "navigation", "url_path": path})
}

// bnav is a web SDK 0.4 navigation: event "browser.navigation" with url.full and enduser.id.
func bnav(sid string, sec int, path string) LokiLine {
	l := line(sid, sec, map[string]string{"event_name": "browser.navigation", "url_full": "https://shop.example" + path + "?ref=x"})
	delete(l.Labels, "user_id")
	l.Labels["enduser_id"] = "e-" + sid
	return l
}

func evt(sid string, sec int, name string) LokiLine {
	return line(sid, sec, map[string]string{"event_name": name})
}

func shop() FunnelQuery {
	return FunnelQuery{Steps: []FunnelStep{
		{Kind: StepPage, Value: "/"},
		{Kind: StepPage, Match: MatchPrefix, Value: "/products/"},
		{Kind: StepEvent, Value: "add_to_cart"},
		{Kind: StepEvent, Value: "order_paid"},
	}}
}

func TestFunnelWalkStrictOrder(t *testing.T) {
	q := shop()
	cases := []struct {
		name  string
		lines []LokiLine
		want  int
	}{
		{"full", []LokiLine{nav("a", 0, "/"), nav("a", 5, "/products/1"), evt("a", 9, "add_to_cart"), evt("a", 20, "order_paid")}, 4},
		{"full on the web SDK 0.4 wire", []LokiLine{bnav("a", 0, "/"), bnav("a", 5, "/products/1"), evt("a", 9, "add_to_cart"), evt("a", 20, "order_paid")}, 4},
		{"out of order: cart before product", []LokiLine{nav("a", 0, "/"), evt("a", 2, "add_to_cart"), nav("a", 5, "/products/1"), evt("a", 20, "order_paid")}, 2},
		{"never step 1", []LokiLine{nav("a", 5, "/products/1"), evt("a", 9, "add_to_cart")}, 0},
		{"repeated steps count once", []LokiLine{nav("a", 0, "/"), nav("a", 1, "/"), nav("a", 2, "/products/1"), nav("a", 3, "/products/2"), evt("a", 4, "add_to_cart"), evt("a", 5, "add_to_cart")}, 3},
		{"prefix does not match exact /", []LokiLine{nav("a", 0, "/products"), nav("a", 1, "/")}, 1},
		{"events in between ignored", []LokiLine{nav("a", 0, "/"), evt("a", 1, "exception"), nav("a", 2, "/about"), nav("a", 3, "/products/9")}, 2},
		{"query and fragment are not the path", []LokiLine{bnav("a", 0, "/"), bnav("a", 1, "/products/1#top")}, 2},
		{"an event named like a page is not a page", []LokiLine{evt("a", 0, "/"), nav("a", 1, "/")}, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, ok := walk(&q, c.lines)
			if c.want == 0 {
				if ok {
					t.Fatalf("got path %+v, want none", p)
				}
				return
			}
			if !ok || p.reached != c.want {
				t.Fatalf("reached %d (ok %v), want %d", p.reached, ok, c.want)
			}
		})
	}
}

func TestFunnelWithinPicksLaterStart(t *testing.T) {
	q := shop()
	q.Within = 30 * time.Second
	// The first visit of / stalls; a second one 10 minutes later converts fast.
	ls := []LokiLine{nav("a", 0, "/"), nav("a", 600, "/"), nav("a", 605, "/products/1"), evt("a", 610, "add_to_cart"), evt("a", 620, "order_paid")}
	if p, ok := walk(&q, ls); !ok || p.reached != 4 || !p.at[0].Equal(t0.Add(600*time.Second)) {
		t.Fatalf("got %+v", p)
	}
	ls = []LokiLine{nav("a", 0, "/"), nav("a", 10, "/products/1"), evt("a", 31, "add_to_cart")}
	if p, _ := walk(&q, ls); p.reached != 2 {
		t.Fatalf("reached %d, want 2", p.reached)
	}
	q.Within = 0
	if p, _ := walk(&q, ls); p.reached != 3 {
		t.Fatalf("reached %d, want 3", p.reached)
	}
}

func TestFunnelReportAndDropped(t *testing.T) {
	q := shop()
	var ls []LokiLine
	ls = append(ls, nav("a", 0, "/"), nav("a", 10, "/products/1"), evt("a", 20, "add_to_cart"), evt("a", 60, "order_paid"))
	ls = append(ls, nav("b", 0, "/"), nav("b", 20, "/products/2"), evt("b", 40, "add_to_cart"))
	ls = append(ls, bnav("c", 0, "/"), bnav("c", 30, "/products/3"))
	ls = append(ls, nav("d", 0, "/"), nav("d", 1, "/about"))
	ls = append(ls, nav("e", 0, "/cart"))                                                                       // never enters
	ls = append(ls, LokiLine{Time: t0, Labels: map[string]string{"event_name": "navigation", "url_path": "/"}}) // no session id
	f := nav("f", 0, "/")
	f.Labels["user_id"] = "u-a" // same user as a, second session
	ls = append(ls, f)

	paths := funnelPaths(&q, ls)
	rows := funnelReport(&q, paths)
	want := []struct {
		sessions, users, dropped int
		fromFirst, fromPrev      float64
	}{
		{5, 4, 0, 100, 0},
		{3, 3, 2, 60, 60},
		{2, 2, 1, 40, 66.67},
		{1, 1, 1, 20, 50},
	}
	for i, w := range want {
		r := rows[i]
		if r.Sessions != w.sessions || r.Users != w.users || r.DroppedOff != w.dropped || r.ConversionFromFirst != w.fromFirst || r.ConversionFromPrevious != w.fromPrev {
			t.Errorf("step %d: got %+v, want %+v", i+1, r, w)
		}
	}
	if rows[0].MedianMs != nil {
		t.Errorf("step 1 has a median")
	}
	// Step 2 gaps: 10s, 20s, 30s: median 20s, p75 30s.
	if *rows[1].MedianMs != 20000 || *rows[1].P75Ms != 30000 {
		t.Errorf("step 2 times %d / %d", *rows[1].MedianMs, *rows[1].P75Ms)
	}
	if rows[1].Label != "page:/products/*" {
		t.Errorf("label %q", rows[1].Label)
	}
	d := dropped(paths, 2)
	if len(d) != 2 || d[0].session != "d" || d[1].session != "f" || d[0].lastPath != "/about" {
		t.Fatalf("dropped at 2: %+v", d)
	}
	if d := dropped(paths, 3); len(d) != 1 || d[0].session != "c" || d[0].user != "e-c" || d[0].lastPath != "/products/3" {
		t.Fatalf("dropped at 3 (web 0.4 wire): %+v", d)
	}
	if d := dropped(paths, 4); len(d) != 1 || d[0].session != "b" {
		t.Errorf("dropped at 4: %+v", d)
	}
	for _, r := range funnelReport(&q, nil) {
		if r.Sessions != 0 || r.ConversionFromFirst != 0 || r.MedianMs != nil {
			t.Fatalf("empty report: %+v", r)
		}
	}
}

func TestParseFunnelStep(t *testing.T) {
	for in, want := range map[string]FunnelStep{
		"page:/":            {Kind: StepPage, Match: MatchExact, Value: "/"},
		"page:/products/*":  {Kind: StepPage, Match: MatchPrefix, Value: "/products/"},
		"event:add_to_cart": {Kind: StepEvent, Value: "add_to_cart"},
		"event:a:b":         {Kind: StepEvent, Value: "a:b"},
	} {
		got, err := ParseFunnelStep(in)
		if err != nil || got != want {
			t.Errorf("%s: got %+v, %v", in, got, err)
		}
		if got.String() != in {
			t.Errorf("round trip %s -> %s", in, got.String())
		}
	}
	for _, bad := range []string{"", "page", "page:", "page:cart", "click:#buy", "event:navigation", "event:browser.navigation",
		`page:/"}`, `event:a\b`, "event:a`b", "page:/a\nb", "page:/" + strings.Repeat("x", 300)} {
		_, err := ParseFunnelStep(bad)
		var br *BadRequestError
		if !errors.As(err, &br) {
			t.Errorf("%q: got %v, want a BadRequestError", bad, err)
		}
	}
	steps, err := ParseFunnelSteps("page:/,page:/a,b*,event:x")
	if err != nil || len(steps) != 3 || steps[1].Value != "/a,b" || steps[1].Match != MatchPrefix {
		t.Fatalf("split: %+v %v", steps, err)
	}
}

// fakeStore answers every request from fn and records the queries it got.
type fakeStore struct {
	mu      sync.Mutex
	queries []string
	fn      func(w http.ResponseWriter, r *http.Request)
}

func (f *fakeStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	q := r.URL.Query()
	f.queries = append(f.queries, q.Get("query")+q.Get("q"))
	f.mu.Unlock()
	f.fn(w, r)
}

func (f *fakeStore) all() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.queries, "\n")
}

func serve(t *testing.T, fn func(w http.ResponseWriter, r *http.Request)) (*fakeStore, string) {
	f := &fakeStore{fn: fn}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv.URL
}

func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func streams(ls ...LokiLine) []byte {
	var res []map[string]any
	for _, l := range ls {
		res = append(res, map[string]any{"stream": l.Labels, "values": [][2]string{{strconv.FormatInt(l.Time.UnixNano(), 10), l.Body}}})
	}
	b, _ := json.Marshal(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": res}})
	return b
}

var rng = TimeRange{From: t0.Add(-time.Hour), To: t0.Add(time.Hour)}

// TestFunnelReader runs Loki.Funnel and FunnelDropped against a fake Loki that answers
// rum-api's real-shaped fixtures (one session started before the range: its step 1 is
// not in them) plus a web SDK 0.4 session.
func TestFunnelReader(t *testing.T) {
	web := streams(bnav("w", 0, "/"), bnav("w", 3, "/products/7"))
	store, u := serve(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		switch {
		case strings.Contains(q, "navigation"):
			// Two answers merged: the fixture (mobile wire) and one web 0.4 session.
			var a, b lokiAnswer
			_ = json.Unmarshal(loadFixture(t, "navigation"), &a)
			_ = json.Unmarshal(web, &b)
			var ra, rb []json.RawMessage
			_ = json.Unmarshal(a.Data.Result, &ra)
			_ = json.Unmarshal(b.Data.Result, &rb)
			res, _ := json.Marshal(append(ra, rb...))
			a.Data.Result = res
			_ = json.NewEncoder(w).Encode(a)
		default:
			_, _ = w.Write(loadFixture(t, "events"))
		}
	})
	l := &Loki{URL: u}
	q := shop()
	q.TimeRange = rng
	q.Within = time.Hour
	q.Filters = Filters{Project: "demo", Service: "tiny-shop-web", Release: "1.0.0"}
	rep, err := l.Funnel(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	got := []int{rep.Steps[0].Sessions, rep.Steps[1].Sessions, rep.Steps[2].Sessions, rep.Steps[3].Sessions}
	if got[0] != 3 || got[1] != 3 || got[2] != 1 || got[3] != 0 || rep.Sessions != 3 || rep.Users != 3 || *rep.WithinMs != 3600000 || rep.Truncated {
		t.Fatalf("report %v %+v", got, rep)
	}
	queries := store.all()
	for _, want := range []string{
		`{service_name="tiny-shop-web", event_name=~"navigation|browser[.]navigation", ouo_project_id="demo"} | service_version="1.0.0" | url_path=~"/|/products/.*" or url_full=~"[^/]*//[^/]*(/|/products/.*)([?#].*)?"`,
		`{service_name="tiny-shop-web", event_name=~"add_to_cart|order_paid", ouo_project_id="demo"} | service_version="1.0.0"`,
	} {
		if !strings.Contains(queries, want) {
			t.Errorf("query %s not sent; sent:\n%s", want, queries)
		}
	}
	d, err := l.FunnelDropped(context.Background(), q, 3, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if d.Total != 2 || len(d.Sessions) != 1 || d.NextOffset == nil || *d.NextOffset != 1 || d.Sessions[0].EnteredAt.IsZero() {
		t.Fatalf("dropped %+v", d)
	}
}

func TestFunnelReaderPages(t *testing.T) {
	// Page size 2: the reader continues from the last timestamp (inclusive, so 5 calls for
	// 5 records) until a page is short.
	all := []LokiLine{nav("p", 0, "/"), nav("p", 1, "/products/1"), evt("p", 2, "x"), evt("p", 3, "y"), evt("p", 4, "z")}
	calls := 0
	_, u := serve(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		start, _ := strconv.ParseInt(r.URL.Query().Get("start"), 10, 64)
		var page []LokiLine
		for _, l := range all {
			if l.Time.UnixNano() >= start && len(page) < 2 {
				page = append(page, l)
			}
		}
		_, _ = w.Write(streams(page...))
	})
	l := &Loki{URL: u, EventLimit: 2}
	lines, trunc, err := l.queryAll(context.Background(), "{x}", t0.Add(-time.Minute), t0.Add(time.Minute))
	if err != nil || trunc || len(lines) != 5 || calls != 5 {
		t.Fatalf("lines %d trunc %v calls %d err %v", len(lines), trunc, calls, err)
	}
	l.FunnelEventLimit = 3
	if lines, trunc, _ = l.queryAll(context.Background(), "{x}", t0.Add(-time.Minute), t0.Add(time.Minute)); !trunc || len(lines) != 3 {
		t.Fatalf("limit: lines %d trunc %v", len(lines), trunc)
	}
}

func TestReadersRejectBeforeQuerying(t *testing.T) {
	store, u := serve(t, func(w http.ResponseWriter, r *http.Request) { t.Errorf("store called: %s", r.URL) })
	l := &Loki{URL: u}
	tp := &Tempo{URL: u}
	ctx := context.Background()
	steps := shop().Steps
	cases := map[string]func() error{
		"one step": func() error { _, err := l.Funnel(ctx, FunnelQuery{Steps: steps[:1]}); return err },
		"bad step value": func() error {
			_, err := l.Funnel(ctx, FunnelQuery{Steps: []FunnelStep{{Kind: StepPage, Value: `/"} |~ "x`}, steps[1]}})
			return err
		},
		"within too long": func() error {
			_, err := l.Funnel(ctx, FunnelQuery{Steps: steps, Within: 8 * 24 * time.Hour})
			return err
		},
		"bad service": func() error {
			_, err := l.Funnel(ctx, FunnelQuery{Steps: steps, Filters: Filters{Service: `a", x="`}})
			return err
		},
		"bad project":  func() error { _, err := l.Health(ctx, HealthQuery{Filters: Filters{Project: "Demo"}}); return err },
		"bad release":  func() error { _, err := l.Health(ctx, HealthQuery{Filters: Filters{Release: "1 0"}}); return err },
		"bad platform": func() error { _, err := l.FunnelSteps(ctx, Filters{Platform: "{web}"}, TimeRange{}, ""); return err },
		"dropped step": func() error { _, err := l.FunnelDropped(ctx, FunnelQuery{Steps: steps}, 1, 0, 0); return err },
		"range too long": func() error {
			_, err := l.Funnel(ctx, FunnelQuery{Steps: steps, TimeRange: TimeRange{From: t0, To: t0.Add(31 * 24 * time.Hour)}})
			return err
		},
		"vitals session": func() error { _, err := l.SessionVitals(ctx, "demo", "../x", TimeRange{}); return err },
		"vitals project": func() error { _, err := l.SessionVitals(ctx, "a b", sess, TimeRange{}); return err },
		"tempo session":  func() error { _, err := tp.SessionTraces(ctx, `x" || true`, TimeRange{}); return err },
	}
	for name, fn := range cases {
		var br *BadRequestError
		if err := fn(); !errors.As(err, &br) {
			t.Errorf("%s: got %v, want a BadRequestError", name, err)
		}
	}
	if q := store.all(); q != "" {
		t.Errorf("queries sent: %s", q)
	}
}

func TestReadersKeepStoreErrorsOut(t *testing.T) {
	_, u := serve(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "secret internal detail at http://loki-7:3100", http.StatusInternalServerError)
	})
	l := &Loki{URL: u}
	tp := &Tempo{URL: u}
	ctx := context.Background()
	q := shop()
	for name, fn := range map[string]func() error{
		"funnel":  func() error { _, err := l.Funnel(ctx, q); return err },
		"dropped": func() error { _, err := l.FunnelDropped(ctx, q, 2, 0, 0); return err },
		"steps":   func() error { _, err := l.FunnelSteps(ctx, Filters{}, TimeRange{}, ""); return err },
		"health":  func() error { _, err := l.Health(ctx, HealthQuery{}); return err },
		"vitals":  func() error { _, err := l.SessionVitals(ctx, proj, sess, TimeRange{}); return err },
		"traces":  func() error { _, err := tp.SessionTraces(ctx, sess, TimeRange{}); return err },
	} {
		var be *BackendError
		err := fn()
		if !errors.As(err, &be) {
			t.Errorf("%s: got %v, want a BackendError", name, err)
			continue
		}
		if strings.Contains(be.Public(), "secret") || strings.Contains(be.Public(), "http") {
			t.Errorf("%s: public message leaks: %q", name, be.Public())
		}
	}
}

func TestFunnelSteps(t *testing.T) {
	store, u := serve(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		var res []map[string]any
		add := func(k, v string, n int) {
			res = append(res, map[string]any{"metric": map[string]string{k: v}, "value": []any{1.0, strconv.Itoa(n)}})
		}
		switch {
		case strings.Contains(q, `"browser.navigation"`):
			add("url_full", "https://shop.example/cart?x=1", 4)
			add("url_full", "https://shop.example/", 1)
		case strings.Contains(q, `"navigation"`):
			add("url_path", "/", 5)
			add("url_path", "/products/1", 2)
		default:
			add("event_name", "add_to_cart", 3)
			add("event_name", "order_paid", 1)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": res}})
	})
	l := &Loki{URL: u}
	s, err := l.FunnelSteps(context.Background(), Filters{Project: "demo"}, rng, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []StepSuggestion{{"/", 6}, {"/cart", 4}, {"/products/1", 2}}
	if len(s.Pages) != 3 || s.Pages[0] != want[0] || s.Pages[1] != want[1] || s.Pages[2] != want[2] {
		t.Fatalf("pages %+v", s.Pages)
	}
	if len(s.Events) != 2 || s.Events[0].Value != "add_to_cart" {
		t.Fatalf("events %+v", s.Events)
	}
	if !strings.Contains(store.all(), `| ouo_event_custom="true" or event_name!~"(session|ouo|browser|app|device)[.].*|exception|navigation|web_vital|http[.]request[.]failed"`) {
		t.Errorf("custom event query: %s", store.all())
	}
	if s, _ := l.FunnelSteps(context.Background(), Filters{}, rng, "prod"); len(s.Pages) != 1 || len(s.Events) != 0 {
		t.Fatalf("contains: %+v", s)
	}
}

func TestClassify(t *testing.T) {
	exc := func(fatal string) LokiLine {
		return LokiLine{Labels: map[string]string{"event_name": "exception", "ouo_exception_fatal": fatal}}
	}
	ev := func(name, reason string) LokiLine {
		return LokiLine{Labels: map[string]string{"event_name": name, "ouo_session_end_reason": reason}}
	}
	cases := []struct {
		name  string
		lines []LokiLine
		want  HealthStatus
	}{
		{"empty", nil, Healthy},
		{"start only", []LokiLine{ev("session.start", "")}, Healthy},
		{"non-fatal", []LokiLine{exc("false")}, Errored},
		{"fatal", []LokiLine{exc("true")}, Crashed},
		{"fatal after non-fatal", []LokiLine{exc("false"), exc("true")}, Crashed},
		{"http failed", []LokiLine{ev("http.request.failed", "")}, Errored},
		{"custom only", []LokiLine{ev("cart.added", "")}, Healthy},
		{"end crash", []LokiLine{ev("session.end", "crash")}, Crashed},
		{"end inactivity", []LokiLine{ev("session.end", "inactivity")}, Healthy},
		{"missing fatal attr", []LokiLine{ev("exception", "")}, Errored},
	}
	for _, c := range cases {
		if got := classify(c.lines); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

// TestHealthReader runs Loki.Health over rum-api's session fixtures. The range is the
// fixtures' hour; web_crashed (A, crashed) and started_at_lag (healthy) are the web sessions that start in it.
func TestHealthReader(t *testing.T) {
	var all []json.RawMessage
	for _, f := range []string{"web_crashed", "mobile_errored", "mobile_crash_end", "started_at_lag", "mobile_vitals"} {
		var a lokiAnswer
		if err := json.Unmarshal(loadFixture(t, f), &a); err != nil {
			t.Fatal(err)
		}
		var r []json.RawMessage
		_ = json.Unmarshal(a.Data.Result, &r)
		all = append(all, r...)
	}
	res, _ := json.Marshal(all)
	store, u := serve(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": json.RawMessage(res)}})
	})
	l := &Loki{URL: u}
	base := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	h, err := l.Health(context.Background(), HealthQuery{TimeRange: TimeRange{From: base, To: base.Add(time.Hour)}, Filters: Filters{Platform: "web"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(store.all(), `{service_name=~".+", event_name=~".+", ouo_platform="web"}`) {
		t.Errorf("query: %s", store.all())
	}
	got := map[string]HealthBucket{}
	for _, b := range h.Buckets {
		got[b.Platform+"/"+b.ServiceName] = b
	}
	web := got["web/web-store"]
	if web.Total != 2 || web.Crashed != 1 || web.Healthy != 1 || web.CrashedPct != 50 {
		t.Errorf("web: %+v", web)
	}
	if h.Totals.Total == 0 || h.Totals.Healthy+h.Totals.Errored+h.Totals.Crashed != h.Totals.Total {
		t.Errorf("totals: %+v", h.Totals)
	}
	var sum float64
	for _, b := range h.Buckets {
		sum += float64(b.Total)
	}
	if int(sum) != h.Totals.Total {
		t.Errorf("buckets %v != totals %d", sum, h.Totals.Total)
	}
}

func TestHealthStartAndRange(t *testing.T) {
	base := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	crash := base.Add(10 * time.Minute)
	started := crash.Add(-400 * time.Millisecond)
	l := func(sid string, at time.Time, labels map[string]string) LokiLine {
		m := map[string]string{"session_id": sid, "ouo_platform": "mobile", "service_name": "app", "service_version": "1"}
		for k, v := range labels {
			m[k] = v
		}
		return LokiLine{Time: at, Labels: m}
	}
	// N: no session.start; session.end carries the SDK's start (N52).
	n := []LokiLine{
		l("N", crash, map[string]string{"event_name": "exception", "ouo_exception_fatal": "true"}),
		l("N", crash, map[string]string{"event_name": "session.end", "ouo_session_end_reason": "crash", "ouo_session_started_at": strconv.FormatInt(started.UnixMilli(), 10)}),
	}
	if got := sessionStart(n); !got.Equal(started) {
		t.Fatalf("start %v want %v", got, started)
	}
	// E: started 1 minute before the range (read through the lookback): left out.
	e := []LokiLine{l("E", base.Add(-time.Minute), map[string]string{"event_name": "session.start"}), l("E", base.Add(time.Minute), map[string]string{"event_name": "exception"})}
	// H: healthy, in range.
	hh := []LokiLine{l("H", base.Add(time.Minute), map[string]string{"event_name": "session.start"})}
	h := healthOf(map[string][]LokiLine{"N": n, "E": e, "H": hh}, base, base.Add(time.Hour), false)
	if h.Totals.Total != 2 || h.Totals.Crashed != 1 || h.Totals.Healthy != 1 || h.Totals.CrashedPct != 50 || len(h.Buckets) != 1 {
		t.Fatalf("health %+v", h)
	}
	if e := healthOf(nil, base, base, false); e.Buckets == nil || len(e.Buckets) != 0 || e.Totals.Total != 0 {
		t.Fatalf("empty: %+v", e)
	}
	b := HealthBucket{}
	for _, s := range []HealthStatus{Crashed, Healthy, Errored} {
		b.add(s)
	}
	b.finish()
	if b.HealthyPct != 33.33 || b.ErroredPct != 33.33 || b.CrashedPct != 33.33 {
		t.Fatalf("pct %+v", b)
	}
}

func TestRatings(t *testing.T) {
	cases := []struct {
		name      string
		got, want Rating
	}{
		{"cold good", rateAppStart("cold", 1999.9), RatingGood},
		{"cold needs", rateAppStart("cold", 2000), RatingNeedsImprovement},
		{"cold needs high", rateAppStart("cold", 4999), RatingNeedsImprovement},
		{"cold poor", rateAppStart("cold", 5000), RatingPoor},
		{"warm good", rateAppStart("warm", 999), RatingGood},
		{"warm needs", rateAppStart("warm", 1000), RatingNeedsImprovement},
		{"warm poor", rateAppStart("warm", 2000), RatingPoor},
		{"unknown start type", rateAppStart("hot", 10), ""},
		{"ttid good", rateTTID(999), RatingGood},
		{"ttid needs", rateTTID(1000), RatingNeedsImprovement},
		{"ttid poor", rateTTID(2500), RatingPoor},
		{"frames good", rateFrames(100, 4, 0), RatingGood},
		{"frames needs at 5%", rateFrames(100, 5, 0), RatingNeedsImprovement},
		{"frames poor at 25%", rateFrames(100, 25, 0), RatingPoor},
		{"one frozen frame is poor", rateFrames(1000, 0, 1), RatingPoor},
		{"no frames no rating", rateFrames(0, 0, 0), ""},
		{"stalls none", rateStalls(0), RatingGood},
		{"stalls needs", rateStalls(999), RatingNeedsImprovement},
		{"stalls poor", rateStalls(1000), RatingPoor},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %q want %q", c.name, c.got, c.want)
		}
	}
	if m := median([]float64{400, 100, 300, 200}); m != 250 {
		t.Fatalf("median: %v", m)
	}
}

func TestSessionVitalsReader(t *testing.T) {
	store, u := serve(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(loadFixture(t, "mobile_vitals")) })
	l := &Loki{URL: u}
	v, err := l.SessionVitals(context.Background(), proj, sess, TimeRange{From: time.UnixMilli(1791280000000), To: time.UnixMilli(1791290000000)})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{ouo_project_id="demo", event_name=~"ouo[.]app[.]start|ouo[.]screen[.]display|app[.]jank|ouo[.]stall"} | session_id="` + sess + `"`; store.all() != want {
		t.Errorf("query %s", store.all())
	}
	vitals, sum := v.Vitals, v.Summary
	if v.SessionID != sess || len(vitals) != 7 {
		t.Fatalf("vitals: %d %+v", len(vitals), vitals)
	}
	if sum.AppStart == nil || *sum.AppStart != (AppStartSummary{Type: "cold", DurationMs: 3060.7, Rating: RatingNeedsImprovement}) {
		t.Fatalf("app_start: %+v", sum.AppStart)
	}
	if sum.Screens == nil || *sum.Screens != 3 {
		t.Fatalf("screens: %v", sum.Screens)
	}
	if sum.TTIDMs == nil || *sum.TTIDMs != (TTIDSummary{P50: 410.2, Max: 3316.2}) {
		t.Fatalf("ttid: %+v", sum.TTIDMs)
	}
	if sum.Frames == nil || *sum.Frames != (FramesSummary{Total: 1840, Slow: 31, Frozen: 1, SlowRatio: 0.0168}) {
		t.Fatalf("frames: %+v", sum.Frames)
	}
	if sum.Stalls == nil || *sum.Stalls != (StallsSummary{Count: 2, TotalMs: 340, LongestMs: 220}) {
		t.Fatalf("stalls: %+v", sum.Stalls)
	}
	as := vitals[0]
	if as.Name != VitalAppStart || as.Screen != "Home" || as.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || as.SpanID != "00f067aa0ba902b7" || as.Rating != RatingNeedsImprovement {
		t.Fatalf("app start: %+v", as)
	}
	if as.Values["type"] != "cold" || as.Values["duration_ms"] != 3060.7 || len(as.Values) != 2 {
		t.Fatalf("app start values: %v", as.Values)
	}
	if want := time.UnixMilli(1791280800000).UTC().Add(3060700 * time.Microsecond); !as.TS.Equal(want) {
		t.Fatalf("app start ts %v want %v", as.TS, want)
	}
	if home := vitals[1]; home.Name != VitalScreenDisplay || home.Values["ttid_ms"] != 3316.2 || home.Rating != RatingPoor {
		t.Fatalf("home: %+v", home)
	}
	jank := vitals[2]
	wantJank := map[string]any{"frame_count": 5.0, "period": 2.5, "total": 120.0, "slow": 4.0, "frozen": 1.0, "delay_ms": 812.5}
	if jank.Name != VitalJank || jank.Rating != RatingPoor || len(jank.Values) != len(wantJank) {
		t.Fatalf("jank: %+v", jank)
	}
	for k, want := range wantJank {
		if jank.Values[k] != want {
			t.Errorf("jank %s: %v want %v", k, jank.Values[k], want)
		}
	}
	if cart := vitals[3]; cart.Values["ttfd_ms"] != 900.0 || cart.Rating != RatingGood || cart.TraceID != "" {
		t.Fatalf("cart: %+v", cart)
	}
	if stall := vitals[4]; stall.Name != VitalStall || stall.Values["count"] != 2.0 || stall.Values["longest_ms"] != 220.0 || stall.Values["period_ms"] != 3000.0 || stall.Rating != RatingNeedsImprovement {
		t.Fatalf("stall: %+v", stall)
	}
	if last := vitals[6]; last.Values["threshold"] != 0.016666666666666666 || last.Rating != RatingGood {
		t.Fatalf("last jank: %+v", last)
	}
	if b, _ := json.Marshal(jank.Values); string(b) != `{"delay_ms":812.5,"frame_count":5,"frozen":1,"period":2.5,"slow":4,"total":120}` {
		t.Fatalf("values json: %s", b)
	}
}

func TestVitalsSummaryAbsentFields(t *testing.T) {
	vitals, sum := vitalsOf(nil)
	if vitals == nil || len(vitals) != 0 {
		t.Fatalf("vitals must be an empty slice: %v", vitals)
	}
	if b, _ := json.Marshal(sum); string(b) != `{}` {
		t.Fatalf("empty summary: %s", b)
	}
	only := []LokiLine{{Time: t0, Labels: map[string]string{"event_name": VitalStall, "ouo_stall_count": "1", "ouo_stall_total_ms": "60", "ouo_stall_longest_ms": "60"}}}
	_, sum = vitalsOf(only)
	if b, _ := json.Marshal(sum); string(b) != `{"stalls":{"count":1,"total_ms":60,"longest_ms":60}}` {
		t.Fatalf("stall-only summary: %s", b)
	}
}

const tempoSample = `{"traces":[
 {"traceID":"aaa","rootServiceName":"web-store","rootTraceName":"documentLoad","startTimeUnixNano":"1791263200697399903","durationMs":48,
  "spanSet":{"matched":4},"serviceStats":{"web-store":{"spanCount":4}}},
 {"traceID":"bbb","rootServiceName":"web-store","rootTraceName":"GET","startTimeUnixNano":"1791263181463000000","durationMs":6,
  "spanSet":{"matched":2},"serviceStats":{"demo-backend":{"spanCount":1},"web-store":{"spanCount":1}}},
 {"traceID":"ccc","rootServiceName":"web-store","rootTraceName":"click","startTimeUnixNano":"1791263100000000000","durationMs":3,
  "serviceStats":{"demo-backend":{"spanCount":2,"errorCount":1}}}
]}`

func TestTempoSessionTraces(t *testing.T) {
	var gotOrg string
	store, u := serve(t, func(w http.ResponseWriter, r *http.Request) {
		gotOrg = r.Header.Get("X-Scope-OrgID")
		q := r.URL.Query()
		if q.Get("start") != "1791263000" || q.Get("end") != "1791264000" || q.Get("spss") != "1" || q.Get("limit") != "1000" {
			t.Errorf("params: %s", r.URL.RawQuery)
		}
		switch qq := q.Get("q"); {
		case strings.Contains(qq, "nestedSetParent"):
			_, _ = w.Write([]byte(`{"traces":[{"traceID":"bbb","spanSet":{"matched":1,"spans":[{"attributes":[{"key":"url.path","value":{"stringValue":"nil"}},{"key":"url.full","value":{"stringValue":"http://localhost:8082/api/checkout?x=1"}}]}]}}]}`))
		case strings.Contains(qq, "status = error"):
			_, _ = w.Write([]byte(`{"traces":[{"traceID":"bbb"}]}`))
		default:
			_, _ = w.Write([]byte(tempoSample))
		}
	})
	tp := &Tempo{URL: u, OrgID: "acme"}
	traces, err := tp.SessionTraces(context.Background(), sess, TimeRange{From: time.Unix(1791263000, 0), To: time.Unix(1791264000, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if gotOrg != "acme" {
		t.Errorf("org %q", gotOrg)
	}
	if len(traces) != 3 || traces[0].TraceID != "aaa" || traces[1].TraceID != "bbb" || traces[2].TraceID != "ccc" {
		t.Fatalf("traces: %+v", traces)
	}
	if traces[0].SpanCount != 4 || traces[1].SpanCount != 2 || traces[0].HasError || !traces[1].HasError {
		t.Fatalf("span counts / errors: %+v", traces)
	}
	// ccc's error span carries no session.id, so the error search misses it; rum-api
	// overwrote the serviceStats answer with the search's and said false.
	if !traces[2].HasError {
		t.Errorf("serviceStats error lost: %+v", traces[2])
	}
	if traces[0].RootName != "documentLoad" || traces[0].DurationMs != 48 || traces[0].Start.Unix() != 1791263200 {
		t.Fatalf("fields: %+v", traces[0])
	}
	if traces[1].RootURLPath != "/api/checkout" || traces[0].RootURLPath != "" {
		t.Errorf("root paths: %+v", traces)
	}
	if !strings.Contains(store.all(), `{ span.session.id = "`+sess+`" }`) || !strings.Contains(store.all(), "select(span.url.path, span.url.full)") {
		t.Errorf("queries: %s", store.all())
	}

	// No traces: one search, an empty (not nil) list.
	store2, u2 := serve(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"traces":[]}`)) })
	got, err := (&Tempo{URL: u2}).SessionTraces(context.Background(), sess, TimeRange{})
	if err != nil || got == nil || len(got) != 0 || strings.Count(store2.all(), "\n") != 0 {
		t.Fatalf("empty: %v %v %q", got, err, store2.all())
	}
}

func TestTempoBestEffortSearches(t *testing.T) {
	// The error and root path searches fail: the traces are still answered.
	_, u := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query().Get("q"); strings.Contains(q, "status = error") || strings.Contains(q, "nestedSetParent") {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"traces":[{"traceID":"t1","rootTraceName":"HTTP GET","startTimeUnixNano":"1791263200000000000"}]}`))
	})
	got, err := (&Tempo{URL: u}).SessionTraces(context.Background(), sess, TimeRange{})
	if err != nil || len(got) != 1 || got[0].HasError || got[0].RootURLPath != "" {
		t.Fatalf("got %+v %v", got, err)
	}
}

func TestTraceWindow(t *testing.T) {
	s := Session{Start: time.Date(2026, 10, 24, 12, 0, 30, 0, time.UTC).UnixMilli(), End: time.Date(2026, 10, 24, 12, 10, 30, 0, time.UTC).UnixMilli()}
	w := TraceWindow(s)
	if !w.From.Equal(time.Date(2026, 10, 24, 11, 58, 0, 0, time.UTC)) || !w.To.Equal(time.Date(2026, 10, 24, 12, 13, 0, 0, time.UTC)) {
		t.Fatalf("window %v - %v", w.From.UTC(), w.To.UTC())
	}
}
