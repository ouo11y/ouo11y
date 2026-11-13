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

type overviewStore struct{ promql []string }

func (o *overviewStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	q := r.URL.Query().Get("query")
	if r.URL.Path == "/prometheus/api/v1/query" {
		o.promql = append(o.promql, q)
		val := "4"
		switch {
		case strings.Contains(q, "STATUS_CODE_ERROR"):
			val = "1"
		case strings.Contains(q, "histogram_quantile"):
			val = "0.25"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector",
			"result": []map[string]any{{"metric": map[string]string{"service": "shop-api"}, "value": []any{1794400000, val}}}}})
		return
	}
	type line struct {
		l   map[string]string
		sec int
	}
	mk := func(project string, n int, platform, event string, sec int, kv ...string) line {
		l := map[string]string{"event_name": event, "session_id": fmt.Sprintf("%032x", n), "ouo_project_id": project, "ouo_platform": platform}
		for i := 0; i+1 < len(kv); i += 2 {
			l[kv[i]] = kv[i+1]
		}
		return line{l, sec}
	}
	var all []line
	if strings.Contains(q, "session[.]start") {
		all = []line{
			mk("demo", 1, "web", "session.start", 0),
			mk("demo", 2, "web", "session.start", 10),
			mk("demo", 3, "ios", "session.start", 20),
			mk("demo", 4, "ios", "session.start", 3000),
			mk("demo", 1, "web", "exception", 5, "exception_type", "PaymentError", "exception_message", "card declined", "ouo_exception_fingerprint", "fp1"),
			mk("demo", 3, "ios", "exception", 25, "exception_type", "PaymentError", "exception_message", "card declined", "ouo_exception_fingerprint", "fp1"),
			mk("demo", 4, "ios", "exception", 3005, "exception_type", "SIGSEGV", "ouo_exception_fatal", "true"),
			mk("secret", 9, "web", "session.start", 0),
		}
	} else {
		all = []line{
			mk("demo", 1, "web", "browser.web_vital", 1, "browser_web_vital_name", "LCP", "browser_web_vital_value", "1200"),
			mk("demo", 2, "web", "browser.web_vital", 11, "browser_web_vital_name", "LCP", "browser_web_vital_value", "2400"),
			mk("demo", 3, "ios", "ouo.app.start", 20, "ouo_app_start_type", "cold", "ouo_app_start_duration_ms", "850.5"),
			mk("demo", 3, "ios", "app.jank", 21, "ouo_frames_total", "200", "ouo_frames_slow", "10", "ouo_frames_frozen", "2"),
		}
	}
	var streams []map[string]any
	for _, l := range all {
		streams = append(streams, map[string]any{"stream": l.l, "values": [][2]string{{fmt.Sprint(t0.Add(time.Duration(l.sec) * time.Second).UnixNano()), ""}}})
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": streams}})
}

func TestOverview(t *testing.T) {
	st := &overviewStore{}
	srv := httptest.NewServer(st)
	defer srv.Close()
	c := &Client{Loki: &Loki{URL: srv.URL}, Mimir: &Mimir{URL: srv.URL + "/prometheus"}, Now: func() time.Time { return t0.Add(time.Hour) }}
	ctx := context.Background()
	noSecret := ClearanceConfig{Projects: map[string]Grants{"secret": {Roles: map[string]Level{"Viewer": None, "Editor": None}}}}

	viewer := Resolve(noSecret, "v", "Viewer", nil)
	ov, err := c.GetOverview(ctx, viewer, OverviewQuery{TimeRange: TimeRange{From: t0, To: t0.Add(time.Hour)}})
	if err != nil {
		t.Fatal(err)
	}
	if ov.Totals.Sessions != 4 || ov.Totals.Errored != 3 || ov.Totals.Crashed != 1 || ov.Totals.Health != 25 || ov.Totals.CrashFree != 75 {
		t.Fatalf("totals: %+v", ov.Totals)
	}
	if len(ov.Health) != 2 || ov.Health[0].Platform != "ios" || ov.Health[0].Sessions != 2 {
		t.Fatalf("health rows: %+v", ov.Health)
	}
	if len(ov.TopErrors) != 2 || ov.TopErrors[0].Fingerprint != "fp1" || ov.TopErrors[0].Sessions != 2 || ov.TopErrors[0].Message != "" {
		t.Fatalf("top errors at c1 (no message): %+v", ov.TopErrors)
	}
	if strings.Join(ov.Redacted, ",") != GroupAttributes {
		t.Fatalf("redacted: %v", ov.Redacted)
	}
	if strings.Join(ov.TopErrors[0].Platforms, ",") != "ios,web" {
		t.Fatalf("platforms: %v", ov.TopErrors[0].Platforms)
	}
	var web float64
	for _, s := range ov.SessionsOverTime {
		if s.Platform == "web" {
			for _, p := range s.Points {
				web += p[1]
			}
		}
	}
	if web != 2 || ov.StepMs != 75000 {
		t.Fatalf("web sessions over time %v, step %d", web, ov.StepMs)
	}
	if len(ov.WebVitals) != 1 || ov.WebVitals[0].Name != "lcp" || ov.WebVitals[0].P75 != 2400 {
		t.Fatalf("web vitals: %+v", ov.WebVitals)
	}
	got := map[string]float64{}
	for _, v := range ov.MobileVitals {
		got[v.Name] = v.P75
	}
	if got["app_start_cold"] != 850.5 || got["slow_frames"] != 5 || got["frozen_frames"] != 1 {
		t.Fatalf("mobile vitals: %+v", ov.MobileVitals)
	}
	if len(ov.Backend) != 1 || ov.Backend[0].ErrorPct != 25 || *ov.Backend[0].P95Ms != 250 {
		t.Fatalf("backend: %+v", ov.Backend)
	}

	editor := Resolve(noSecret, "e", "Editor", nil)
	ov, _ = c.GetOverview(ctx, editor, OverviewQuery{})
	if ov.TopErrors[0].Message != "card declined" || ov.TopErrors[0].Type != "PaymentError" || len(ov.Redacted) != 0 {
		t.Fatalf("top errors at c3: %+v %v", ov.TopErrors[0], ov.Redacted)
	}
	admin := Resolve(ClearanceConfig{}, "a", "Admin", nil)
	ov, _ = c.GetOverview(ctx, admin, OverviewQuery{})
	if ov.Totals.Sessions != 5 {
		t.Fatalf("admin sees the secret project too: %+v", ov.Totals)
	}
	if _, err := c.GetOverview(ctx, Clearance{}, OverviewQuery{}); err != ErrForbidden {
		t.Fatalf("level 0: %v", err)
	}
}
