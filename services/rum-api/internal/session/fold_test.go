package session

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

var base = time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)

func load(t *testing.T, name string) []Event {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	evs, err := ParseLokiResponse(b)
	if err != nil {
		t.Fatal(err)
	}
	return evs
}

func str(s string) *string { return &s }

type want struct {
	status            Status
	state             State
	endReason         *string
	platform, service string
	version, user     string
	errors, crashes   int
	failed, events    int
	startedAt         time.Time
	endedAt           *time.Time
}

func TestFoldFixtures(t *testing.T) {
	cases := []struct {
		fixture string
		now     time.Time
		want    map[string]want
	}{
		{
			fixture: "web_crashed",
			now:     base.Add(5 * time.Minute),
			want: map[string]want{
				"A": {status: StatusCrashed, state: StateActive, platform: "web", service: "web-store", version: "1.4.2", user: "u1",
					errors: 1, crashes: 1, failed: 1, events: 7, startedAt: base},
			},
		},
		{
			fixture: "mobile_errored",
			now:     base.Add(5 * time.Minute),
			want: map[string]want{
				"B": {status: StatusErrored, state: StateActive, platform: "mobile", service: "mobile-store", version: "9.9.9", user: "mob-1",
					errors: 1, events: 2, startedAt: base},
			},
		},
		{
			fixture: "mobile_crash_end",
			now:     base.Add(5 * time.Minute),
			want: map[string]want{
				"C": {status: StatusCrashed, state: StateEnded, endReason: str("crash"), platform: "mobile", service: "mobile-store", version: "2.0.0", user: "u1",
					events: 2, startedAt: base, endedAt: ptr(base.Add(30 * time.Second))},
			},
		},
		{
			fixture: "inferred_ends",
			now:     base.Add(45 * time.Minute),
			want: map[string]want{
				"D": {status: StatusHealthy, state: StateEnded, endReason: str("inactivity"), platform: "web", service: "web-store", version: "1.4.2", user: "u1",
					events: 2, startedAt: base, endedAt: ptr(base.Add(time.Minute))},
				"E": {status: StatusHealthy, state: StateEnded, endReason: str("max_duration"), platform: "web", service: "web-store", version: "1.4.2", user: "u1",
					events: 2, startedAt: base.Add(-5 * time.Hour), endedAt: ptr(base)},
			},
		},
		{
			fixture: "explicit_end_http_failed",
			now:     base.Add(time.Hour),
			want: map[string]want{
				"F": {status: StatusErrored, state: StateEnded, endReason: str("inactivity"), platform: "web", service: "web-store", version: "1.4.2", user: "u1",
					failed: 1, events: 3, startedAt: base, endedAt: ptr(base.Add(31 * time.Minute))},
			},
		},
		{
			fixture: "mixed",
			now:     base.Add(2 * time.Minute),
			want: map[string]want{
				"G": {status: StatusHealthy, state: StateActive, platform: "web", service: "web-store", version: "1.4.2", user: "late-user", events: 2, startedAt: base.Add(100 * time.Second)},
				"H": {status: StatusHealthy, state: StateActive, platform: "web", service: "web-store", version: "1.4.2", user: "u1", events: 1, startedAt: base.Add(50 * time.Second)},
				"I": {status: StatusCrashed, state: StateActive, platform: "web", service: "web-store", version: "1.4.2", user: "u1", crashes: 1, events: 2, startedAt: base.Add(70 * time.Second)},
			},
		},
		{
			fixture: "started_at_lag",
			now:     base.Add(time.Minute),
			want: map[string]want{
				"J": {status: StatusHealthy, state: StateActive, platform: "web", service: "web-store", version: "1.4.2", user: "u1", events: 2, startedAt: base},
			},
		},
		{
			fixture: "loki_web_real",
			now:     time.Unix(1791263200, 0).Add(time.Minute),
			want: map[string]want{
				"a4d47dfa-db30-4856-9bfe-3a657ccc9471": {status: StatusCrashed, state: StateActive, platform: "web", service: "web-store", version: "1.4.2",
					user: "3c63803d-6d13-4d79-944a-72c1c26f23cb", errors: 2, crashes: 1, failed: 1, events: 12,
					startedAt: time.UnixMilli(1791263180896).UTC()},
			},
		},
	}
	for _, c := range cases {
		t.Run(c.fixture, func(t *testing.T) {
			recs := Fold(load(t, c.fixture), c.now, DefaultOptions)
			if len(recs) != len(c.want) {
				t.Fatalf("got %d records, want %d: %+v", len(recs), len(c.want), recs)
			}
			for _, r := range recs {
				w, ok := c.want[r.SessionID]
				if !ok {
					t.Errorf("unexpected session %s", r.SessionID)
					continue
				}
				check := func(field string, got, want any) {
					if got != want {
						t.Errorf("%s.%s = %v, want %v", r.SessionID, field, got, want)
					}
				}
				check("status", r.Status, w.status)
				check("state", r.State, w.state)
				check("platform", r.Platform, w.platform)
				check("service", r.ServiceName, w.service)
				check("version", r.ServiceVersion, w.version)
				check("user", r.UserID, w.user)
				check("error_count", r.ErrorCount, w.errors)
				check("crash_count", r.CrashCount, w.crashes)
				check("failed_request_count", r.FailedRequestCount, w.failed)
				check("event_count", r.EventCount, w.events)
				if !r.StartedAt.Equal(w.startedAt) {
					t.Errorf("%s.started_at = %v, want %v", r.SessionID, r.StartedAt, w.startedAt)
				}
				if (r.EndReason == nil) != (w.endReason == nil) || (r.EndReason != nil && *r.EndReason != *w.endReason) {
					t.Errorf("%s.end_reason = %v, want %v", r.SessionID, deref(r.EndReason), deref(w.endReason))
				}
				if (r.EndedAt == nil) != (w.endedAt == nil) || (r.EndedAt != nil && !r.EndedAt.Equal(*w.endedAt)) {
					t.Errorf("%s.ended_at = %v, want %v", r.SessionID, r.EndedAt, w.endedAt)
				}
				if r.State == StateActive && (r.EndedAt != nil || r.EndReason != nil) {
					t.Errorf("%s: active session must have null ended_at/end_reason", r.SessionID)
				}
			}
		})
	}
}

func TestFoldOrderAndTimeline(t *testing.T) {
	recs := Fold(load(t, "mixed"), base.Add(2*time.Minute), DefaultOptions)
	ids := []string{recs[0].SessionID, recs[1].SessionID, recs[2].SessionID}
	if ids[0] != "G" || ids[1] != "I" || ids[2] != "H" {
		t.Fatalf("expected started_at desc order G,I,H got %v", ids)
	}
	a := Fold(load(t, "web_crashed"), base, DefaultOptions)[0]
	var names []string
	for _, ev := range a.Events {
		names = append(names, string(ev.Type()))
	}
	wantNames := []string{"session.start", "navigation", "web_vital", "exception", "http.request.failed", "custom", "exception"}
	for i := range wantNames {
		if names[i] != wantNames[i] {
			t.Fatalf("timeline order %v, want %v", names, wantNames)
		}
	}
	ev := a.Events[5]
	if ev.Name != "cart.added" || ev.Attrs["sku"] != "sku-1" || ev.Attrs["ouo_event_custom"] != "true" {
		t.Errorf("custom event attrs not flattened: %+v", ev)
	}
	if _, ok := ev.Attrs["session_id"]; ok {
		t.Errorf("identifier keys must not be duplicated into attrs")
	}
	if _, ok := ev.Attrs["telemetry_sdk_name"]; ok {
		t.Errorf("noise keys must be stripped from attrs")
	}
}

func TestClassifyTable(t *testing.T) {
	exc := func(fatal string) Event {
		return Event{Name: "exception", Attrs: map[string]string{"ouo_exception_fatal": fatal}}
	}
	cases := []struct {
		name string
		evs  []Event
		want Status
	}{
		{"empty", nil, StatusHealthy},
		{"start only", []Event{{Name: "session.start"}}, StatusHealthy},
		{"non-fatal", []Event{exc("false")}, StatusErrored},
		{"fatal", []Event{exc("true")}, StatusCrashed},
		{"fatal after non-fatal", []Event{exc("false"), exc("true")}, StatusCrashed},
		{"http failed", []Event{{Name: "http.request.failed"}}, StatusErrored},
		{"custom only", []Event{{Name: "cart.added"}}, StatusHealthy},
		{"end crash", []Event{{Name: "session.end", Attrs: map[string]string{"ouo_session_end_reason": "crash"}}}, StatusCrashed},
		{"end inactivity", []Event{{Name: "session.end", Attrs: map[string]string{"ouo_session_end_reason": "inactivity"}}}, StatusHealthy},
		{"missing fatal attr", []Event{{Name: "exception", Attrs: map[string]string{}}}, StatusErrored},
	}
	for _, c := range cases {
		if got := Classify(c.evs); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

func TestHealth(t *testing.T) {
	recs := []Record{
		{Platform: "web", ServiceName: "web-store", ServiceVersion: "1.4.2", Status: StatusCrashed},
		{Platform: "web", ServiceName: "web-store", ServiceVersion: "1.4.2", Status: StatusHealthy},
		{Platform: "web", ServiceName: "web-store", ServiceVersion: "1.4.2", Status: StatusErrored},
		{Platform: "mobile", ServiceName: "mobile-store", ServiceVersion: "9.9.9", Status: StatusErrored},
	}
	h := Health(recs)
	if len(h.Buckets) != 2 || h.Buckets[0].Platform != "mobile" || h.Buckets[1].Platform != "web" {
		t.Fatalf("buckets: %+v", h.Buckets)
	}
	web := h.Buckets[1]
	if web.Total != 3 || web.Healthy != 1 || web.Errored != 1 || web.Crashed != 1 {
		t.Fatalf("web counts: %+v", web)
	}
	if web.HealthyPct != 33.33 || web.ErroredPct != 33.33 || web.CrashedPct != 33.33 {
		t.Fatalf("web pct: %+v", web)
	}
	if h.Buckets[0].ErroredPct != 100 || h.Totals.Total != 4 || h.Totals.ErroredPct != 50 {
		t.Fatalf("totals: %+v %+v", h.Buckets[0], h.Totals)
	}
	if e := Health(nil); len(e.Buckets) != 0 || e.Totals.Total != 0 {
		t.Fatalf("empty: %+v", e)
	}
}

func TestParseLokiResponseErrors(t *testing.T) {
	if _, err := ParseLokiResponse([]byte(`{"status":"error"}`)); err == nil {
		t.Fatal("expected status error")
	}
	if _, err := ParseLokiResponse([]byte(`not json`)); err == nil {
		t.Fatal("expected decode error")
	}
	if _, err := ParseLokiResponse([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)); err == nil {
		t.Fatal("expected resultType error")
	}
}

func ptr(t time.Time) *time.Time { return &t }

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func TestSessionContext(t *testing.T) {
	evs := EventsFromStreams([]LokiStream{
		{Stream: map[string]string{"event_name": "session.start", "session_id": "s1", "os_name": "iOS", "os_version": "26.0",
			"device_model_identifier": "iPhone18,1", "deployment_environment_name": "staging"}, Values: [][2]string{{"1000000000", ""}}},
		{Stream: map[string]string{"event_name": "ui.tap", "session_id": "s1", "os_version": "27.0", "ouo_app_build": "42"},
			Values: [][2]string{{"2000000000", ""}}},
		{Stream: map[string]string{"event_name": "log", "session_id": "s1", "message": "no context"}, Values: [][2]string{{"3000000000", ""}}},
	})
	got := SessionContext(evs)
	want := map[string]string{"os_name": "iOS", "os_version": "27.0", "device_model_identifier": "iPhone18,1",
		"deployment_environment_name": "staging", "ouo_app_build": "42"}
	if len(got) != len(want) {
		t.Fatalf("context: %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q (latest event wins)", k, got[k], v)
		}
	}
	if _, ok := evs[0].Attrs["os_name"]; ok {
		t.Error("os_name must stay out of Attrs")
	}
	if SessionContext(evs[2:]) != nil {
		t.Error("no context keys: want nil")
	}
}
