package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/tempo"
)

// newVitalsServer serves the mobile vitals fixture (a Loki query_range
// response with the four vital event names, session "V") plus the web
// fixture.
func newVitalsServer(t *testing.T) (*httptest.Server, *fakeEvents) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "session", "testdata", "mobile_vitals.json"))
	if err != nil {
		t.Fatal(err)
	}
	evs, err := session.ParseLokiResponse(b)
	if err != nil {
		t.Fatal(err)
	}
	evs = append(evs, fixtureEvents(t)...)
	session.SortEvents(evs)
	fe := &fakeEvents{events: evs}
	store, err := replay.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1791280800000).Add(10 * time.Minute)
	srv := New(fe, &fakeTraces{traces: map[string][]tempo.Trace{}}, store, Options{Now: func() time.Time { return now }})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, fe
}

func TestSessionVitals(t *testing.T) {
	ts, fe := newVitalsServer(t)

	resp, err := http.Get(ts.URL + "/v1/sessions/V/vitals")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("vitals: %d", resp.StatusCode)
	}
	var raw struct {
		SessionID string                     `json:"session_id"`
		Summary   map[string]json.RawMessage `json:"summary"`
		Vitals    []map[string]any           `json:"vitals"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if raw.SessionID != "V" || len(raw.Vitals) != 7 {
		t.Fatalf("vitals response: %+v", raw)
	}
	wantSummary := map[string]string{
		"app_start": `{"type":"cold","duration_ms":3060.7,"rating":"needs-improvement"}`,
		"screens":   `3`,
		"ttid_ms":   `{"p50":410.2,"max":3316.2}`,
		"frames":    `{"total":1840,"slow":31,"frozen":1,"slow_ratio":0.0168}`,
		"stalls":    `{"count":2,"total_ms":340,"longest_ms":220}`,
	}
	if len(raw.Summary) != len(wantSummary) {
		t.Fatalf("summary keys: %v", raw.Summary)
	}
	for k, want := range wantSummary {
		if got := string(raw.Summary[k]); got != want {
			t.Errorf("summary.%s = %s, want %s", k, got, want)
		}
	}
	home := raw.Vitals[1]
	if home["ts"] != "2026-10-06T10:00:03.3162Z" || home["name"] != "ouo.screen.display" || home["screen"] != "Home" ||
		home["trace_id"] != "4bf92f3577b34da6a3ce929d0e0e4736" || home["span_id"] != "00f067aa0ba902b7" || home["rating"] != "poor" {
		t.Fatalf("home vital: %v", home)
	}
	if v := home["values"].(map[string]any); v["ttid_ms"] != 3316.2 || len(v) != 1 {
		t.Fatalf("home values: %v", v)
	}
	if _, ok := raw.Vitals[3]["trace_id"]; ok {
		t.Fatalf("trace_id must be omitted when the record has none: %v", raw.Vitals[3])
	}

	// A session without vitals: empty summary object, empty array.
	var none vitalsResponse
	resp2, _ := http.Get(ts.URL + "/v1/sessions/" + realSession + "/vitals")
	var noneRaw map[string]any
	json.NewDecoder(resp2.Body).Decode(&noneRaw)
	resp2.Body.Close()
	if s, ok := noneRaw["summary"].(map[string]any); !ok || len(s) != 0 {
		t.Fatalf("summary without vitals: %v", noneRaw)
	}
	if v, ok := noneRaw["vitals"].([]any); !ok || len(v) != 0 {
		t.Fatalf("vitals without vitals: %v", noneRaw)
	}

	if code := getJSON(t, ts.URL+"/v1/sessions/unknown/vitals", &none); code != 404 {
		t.Fatalf("unknown session: %d", code)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/bad%20id/vitals", nil); code != 400 {
		t.Fatalf("bad id: %d", code)
	}
	fe.err = errors.New("connection refused")
	if code := getJSON(t, ts.URL+"/v1/sessions/V/vitals", nil); code != http.StatusBadGateway {
		t.Fatalf("loki down: %d", code)
	}
	fe.err = nil
}

func TestVitalsInDetailListAndLogs(t *testing.T) {
	ts, _ := newVitalsServer(t)

	var d detailResponse
	if code := getJSON(t, ts.URL+"/v1/sessions/V", &d); code != 200 {
		t.Fatalf("detail: %d", code)
	}
	var vitals []string
	for _, it := range d.Timeline {
		if it.Type == session.TypeVital {
			vitals = append(vitals, it.Name)
		}
	}
	want := []string{"ouo.app.start", "ouo.screen.display", "app.jank", "ouo.screen.display", "ouo.stall", "ouo.screen.display", "app.jank"}
	if len(vitals) != len(want) {
		t.Fatalf("vital timeline entries: %v", vitals)
	}
	for i := range want {
		if vitals[i] != want[i] {
			t.Fatalf("vital timeline entries: %v", vitals)
		}
	}
	if d.AppStartMs == nil || *d.AppStartMs != 3060.7 || d.AppStartType != "cold" {
		t.Fatalf("detail app start: %v %q", d.AppStartMs, d.AppStartType)
	}

	var list struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if code := getJSON(t, ts.URL+"/v1/sessions?from=2026-10-06T09:00:00Z&to=2026-10-06T11:00:00Z", &list); code != 200 {
		t.Fatalf("list: %d", code)
	}
	var found bool
	for _, s := range list.Sessions {
		if s["session_id"] == "V" {
			found = true
			if s["app_start_ms"] != 3060.7 || s["app_start_type"] != "cold" {
				t.Fatalf("list app start: %v", s)
			}
		} else if _, ok := s["app_start_ms"]; ok {
			t.Fatalf("app_start_ms on a session without an app start: %v", s)
		}
	}
	if !found {
		t.Fatalf("session V not listed: %v", list.Sessions)
	}

	// Vitals are timeline, not log lines.
	var logs logsResponse
	if code := getJSON(t, ts.URL+"/v1/sessions/V/logs", &logs); code != 200 {
		t.Fatalf("logs: %d", code)
	}
	for _, l := range logs.Logs {
		if session.IsVital(l.EventName) {
			t.Fatalf("vital in logs: %+v", l)
		}
	}
}
