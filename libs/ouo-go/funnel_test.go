package ouogo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var t0 = time.Unix(1794400000, 0)

func rec(sec int, event string, kv ...string) FunnelRecord {
	l := map[string]string{"event_name": event, "session_id": sess, "ouo_project_id": proj, "ouo_platform": "web"}
	for i := 0; i+1 < len(kv); i += 2 {
		l[kv[i]] = kv[i+1]
	}
	return FunnelRecord{Time: t0.Add(time.Duration(sec) * time.Second), Labels: l}
}

func shop() Funnel {
	f := Funnel{ID: "shop", Steps: []FunnelStep{
		{Kind: StepPage, Value: "/products", Prefix: true},
		{Kind: StepEvent, Value: "cart.add"},
		{Kind: StepEvent, Value: "checkout.start"},
		{Kind: StepEvent, Value: "payment.submit", Where: []Condition{{Key: "payment.method", Value: "card"}}},
		{Kind: StepEvent, Value: "order.placed"},
	}}
	if err := f.Validate(); err != nil {
		panic(err)
	}
	return f
}

func TestWalkFunnel(t *testing.T) {
	web := func(sec int, path string) FunnelRecord {
		return rec(sec, "browser.navigation", "url_full", "https://shop.example"+path+"?q=1")
	}
	screen := func(sec int, path string) FunnelRecord {
		return rec(sec, "navigation", "url_path", path, "ouo_platform", "ios")
	}
	cases := []struct {
		name       string
		within     int64
		recs       []FunnelRecord
		reached    int
		failed     bool
		failedWith string
	}{
		{"never starts", 0, []FunnelRecord{rec(0, "cart.add")}, 0, false, ""},
		{"web converts", 0, []FunnelRecord{web(0, "/products/7"), rec(1, "cart.add"), rec(2, "checkout.start"),
			rec(3, "payment.submit", "payment_method", "card"), rec(4, "order.placed")}, 5, false, ""},
		{"mobile screen path counts as a page", 0, []FunnelRecord{screen(0, "/products/7"), rec(1, "cart.add")}, 2, false, ""},
		{"wrong order does not count", 0, []FunnelRecord{rec(0, "cart.add"), web(1, "/products/1")}, 1, false, ""},
		{"condition must hold", 0, []FunnelRecord{web(0, "/products"), rec(1, "cart.add"), rec(2, "checkout.start"),
			rec(3, "payment.submit", "payment_method", "paypal")}, 3, false, ""},
		{"failed: exception after the last step", 0, []FunnelRecord{web(0, "/products"), rec(1, "cart.add"), rec(2, "checkout.start"),
			rec(3, "exception")}, 3, true, "exception"},
		{"exception before the last step is not a failure", 0, []FunnelRecord{web(0, "/products"), rec(1, "exception"), rec(2, "cart.add")}, 2, false, ""},
		{"a session that failed and still converted is not failed", 0, []FunnelRecord{web(0, "/products"), rec(1, "cart.add"), rec(2, "exception"),
			rec(3, "checkout.start"), rec(4, "payment.submit", "payment_method", "card"), rec(5, "order.placed")}, 5, false, ""},
		{"window ends the attempt", 10, []FunnelRecord{web(0, "/products"), rec(20, "cart.add")}, 1, false, ""},
		{"a later attempt wins", 10, []FunnelRecord{web(0, "/products"), web(100, "/products/2"), rec(105, "cart.add")}, 2, false, ""},
		{"failure outside the window is abandoned", 10, []FunnelRecord{web(0, "/products"), rec(30, "exception")}, 1, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := shop()
			f.WithinSeconds = tc.within
			p, ok := WalkFunnel(f, tc.recs)
			if tc.reached == 0 {
				if ok {
					t.Fatalf("want no path, got %+v", p)
				}
				return
			}
			if !ok || p.Reached != tc.reached || p.Failed != tc.failed || p.FailedWith != tc.failedWith {
				t.Fatalf("got reached %d failed %v %q, want %d %v %q", p.Reached, p.Failed, p.FailedWith, tc.reached, tc.failed, tc.failedWith)
			}
		})
	}
}

func TestFunnelReport(t *testing.T) {
	f := shop()
	paths := []FunnelPath{
		{Platform: "web", Reached: 5, At: steps(0, 1, 2, 3, 4)},
		{Platform: "ios", Reached: 5, At: steps(0, 2, 4, 6, 8)},
		{Platform: "ios", Reached: 3, At: steps(0, 1, 2), Failed: true},
		{Platform: "web", Reached: 3, At: steps(0, 1, 2)},
		{Platform: "web", Reached: 1, At: steps(0)},
	}
	rows := FunnelReportOf(f, paths)
	want := []struct {
		sessions, dropped, failed int
		fromFirst, failureRate    float64
	}{{5, 0, 0, 100, 0}, {4, 1, 0, 80, 0}, {4, 0, 0, 80, 0}, {2, 2, 1, 40, 25}, {2, 0, 0, 40, 0}}
	for i, w := range want {
		r := rows[i]
		if r.Sessions != w.sessions || r.DroppedOff != w.dropped || r.Failed != w.failed || r.ConversionFromFirst != w.fromFirst || r.FailureRate != w.failureRate {
			t.Errorf("step %d: got %+v, want %+v", i+1, r, w)
		}
	}
	if rows[0].ByPlatform["web"] != 3 || rows[0].ByPlatform["ios"] != 2 {
		t.Errorf("by platform: %v", rows[0].ByPlatform)
	}
	if rows[1].MedianMs == nil || *rows[1].MedianMs != 1000 {
		t.Errorf("median step 2: %v", rows[1].MedianMs)
	}
}

func steps(secs ...int) []time.Time {
	var out []time.Time
	for _, s := range secs {
		out = append(out, t0.Add(time.Duration(s)*time.Second))
	}
	return out
}

func TestFunnelValidate(t *testing.T) {
	bad := []Funnel{
		{ID: "x", Steps: []FunnelStep{{Kind: StepPage, Value: "/a"}}},
		{ID: "x", Steps: []FunnelStep{{Kind: StepPage, Value: "a"}, {Kind: StepEvent, Value: "b"}}},
		{ID: "x", Steps: []FunnelStep{{Kind: StepPage, Value: "/a"}, {Kind: StepEvent, Value: "navigation"}}},
		{ID: "x", Steps: []FunnelStep{{Kind: StepPage, Value: "/a"}, {Kind: StepEvent, Value: `a"b`}}},
		{ID: "x", Steps: []FunnelStep{{Kind: StepPage, Value: "/a"}, {Kind: StepEvent, Value: "b", Where: []Condition{{Key: "session.id", Value: "1"}}}}},
		{ID: "x", Steps: []FunnelStep{{Kind: StepPage, Value: "/a"}, {Kind: StepEvent, Value: "b", Where: []Condition{{Key: "k", Op: "=~", Value: "("}}}}},
		{ID: "Bad Id", Steps: []FunnelStep{{Kind: StepPage, Value: "/a"}, {Kind: StepEvent, Value: "b"}}},
	}
	for i, f := range bad {
		if err := f.Validate(); err == nil {
			t.Errorf("case %d: want an error", i)
		}
	}
	f := shop()
	if f.Failure == nil || f.Failure.Value != "exception" || f.Steps[0].Label != "page:/products*" {
		t.Errorf("defaults: %+v %q", f.Failure, f.Steps[0].Label)
	}
	if err := ValidateFunnels([]Funnel{shop(), shop()}); err == nil {
		t.Error("duplicate ids: want an error")
	}
}

// funnelLoki answers query_range with the records of a few sessions in two projects.
type funnelLoki struct{ queries []string }

func (f *funnelLoki) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("query")
	f.queries = append(f.queries, q)
	type line struct {
		labels map[string]string
		sec    int
	}
	sid := func(n int) string { return fmt.Sprintf("%032x", n) }
	mk := func(project string, n int, platform, event string, sec int, kv ...string) line {
		l := map[string]string{"event_name": event, "session_id": sid(n), "ouo_project_id": project, "ouo_platform": platform, "enduser_id": "user-" + sid(n)[28:]}
		for i := 0; i+1 < len(kv); i += 2 {
			l[kv[i]] = kv[i+1]
		}
		return line{l, sec}
	}
	all := []line{
		mk("demo", 1, "web", "browser.navigation", 0, "url_full", "https://s/products/1"),
		mk("demo", 1, "web", "cart.add", 1),
		mk("demo", 1, "web", "checkout.start", 2),
		mk("demo", 1, "web", "exception", 3, "exception_message", "card declined"),
		mk("demo", 2, "ios", "navigation", 0, "url_path", "/products"),
		mk("demo", 2, "ios", "cart.add", 1),
		mk("demo", 2, "ios", "checkout.start", 2),
		mk("demo", 2, "ios", "payment.submit", 3, "payment_method", "card"),
		mk("demo", 2, "ios", "order.placed", 4),
		mk("demo", 3, "android", "navigation", 0, "url_path", "/products/9"),
		mk("demo", 3, "android", "cart.add", 1),
		mk("demo", 3, "android", "checkout.start", 2),
		mk("secret", 4, "web", "browser.navigation", 0, "url_full", "https://s/products/1"),
		mk("secret", 4, "web", "cart.add", 1),
	}
	var streams []map[string]any
	for _, l := range all {
		nav := l.labels["event_name"] == "browser.navigation" || l.labels["event_name"] == "navigation"
		if strings.Contains(q, "navigation") != nav {
			continue
		}
		if strings.Contains(q, `ouo_project_id="demo"`) && l.labels["ouo_project_id"] != "demo" {
			continue
		}
		streams = append(streams, map[string]any{"stream": l.labels, "values": [][2]string{{fmt.Sprint(t0.Add(time.Duration(l.sec) * time.Second).UnixNano()), ""}}})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": streams}})
}

func TestRunFunnelClearance(t *testing.T) {
	fl := &funnelLoki{}
	srv := httptest.NewServer(fl)
	defer srv.Close()
	c := &Client{Loki: &Loki{URL: srv.URL}, Now: func() time.Time { return t0.Add(time.Hour) }}
	ctx := context.Background()
	f := shop()

	viewer := Resolve(ClearanceConfig{Projects: map[string]Grants{"secret": {Roles: map[string]Level{"Viewer": None}}}}, "v", "Viewer", nil)
	rep, err := c.RunFunnel(ctx, viewer, f, FunnelQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if got := rep.Steps[0].Sessions; got != 3 {
		t.Fatalf("viewer sees the 3 demo sessions (not the secret one), got %d", got)
	}
	if rep.Steps[3].Sessions != 1 || rep.Steps[3].DroppedOff != 2 || rep.Steps[3].Failed != 1 {
		t.Fatalf("payment step: %+v", rep.Steps[3])
	}
	if len(fl.queries) != 2 || !strings.Contains(fl.queries[1], `event_name=~"cart\\.add|checkout\\.start|payment\\.submit|order\\.placed|exception"`) {
		t.Fatalf("queries: %q", fl.queries)
	}

	dropped, err := c.FunnelDropped(ctx, viewer, f, FunnelQuery{}, 4, OutcomeFailed, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(dropped.Sessions) != 1 || dropped.Sessions[0].ID != fmt.Sprintf("%032x", 1) || dropped.Sessions[0].User != "" || dropped.Sessions[0].FailedWith != "exception" {
		t.Fatalf("failed drop-offs at c1: %+v", dropped)
	}
	if strings.Join(dropped.Redacted, ",") != GroupIdentity {
		t.Fatalf("redacted: %v", dropped.Redacted)
	}
	admin := Resolve(ClearanceConfig{}, "a", "Admin", nil)
	dropped, _ = c.FunnelDropped(ctx, admin, f, FunnelQuery{Project: "demo"}, 4, "", 0)
	if len(dropped.Sessions) != 2 || dropped.Sessions[0].User == "" {
		t.Fatalf("admin drop-offs: %+v", dropped)
	}
	if _, err := c.RunFunnel(ctx, Clearance{}, f, FunnelQuery{}); err != ErrForbidden {
		t.Fatalf("level 0: %v", err)
	}
	if _, err := c.FunnelDropped(ctx, admin, f, FunnelQuery{}, 1, "", 0); err == nil {
		t.Fatal("step 1 has no drop-off")
	}
}

func TestPlatformOf(t *testing.T) {
	for want, labels := range map[string]map[string]string{
		"ios":     {"ouo_platform": "ios", "telemetry_sdk_name": "@ouo11y/browser"},
		"web":     {"telemetry_sdk_name": "@ouo11y/browser"},
		"android": {"os_name": "Android"},
		"unknown": {},
	} {
		if got := PlatformOf(labels); got != want {
			t.Errorf("%v: %q, want %q", labels, got, want)
		}
	}
	if got := PlatformOf(map[string]string{"os_name": "iPadOS"}); got != "ios" {
		t.Errorf("iPadOS: %q", got)
	}
}
