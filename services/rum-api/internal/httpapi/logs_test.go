package httpapi

import (
	"errors"
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

func newLogsServer(t *testing.T, tracesErr error) (*httptest.Server, *fakeEvents, time.Time) {
	t.Helper()
	evs := fixtureEvents(t)
	var at time.Time
	for _, ev := range evs {
		if ev.SessionID == realSession {
			at = ev.TS
		}
	}
	tid := "00000000000000000000000000000aaa" // Tempo search returns "aaa"
	fe := &fakeEvents{events: append(evs,
		session.Event{TS: at, Name: "log", Line: "cart loaded", SessionID: realSession, ServiceName: "shop",
			Attrs: map[string]string{"severity_text": "WARN", "trace_id": tid, "message": "cart loaded", "cart_items": "3"}},
		session.Event{TS: at, Name: "navigation", Line: "navigation", SessionID: realSession, ServiceName: "shop", Attrs: map[string]string{}},
	)}
	fe.extra = []session.Event{
		{TS: at.Add(time.Millisecond), Line: "request", ServiceName: "demo-backend",
			Attrs: map[string]string{"severity_text": "INFO", "trace_id": tid, "span_id": "8ee5b22281ab2e4f", "http_route": "/api/cart"}},
		{TS: at, Line: "someone else's request", ServiceName: "demo-backend", Attrs: map[string]string{"trace_id": "ffffffffffffffffffffffffffffffff"}},
	}
	ft := &fakeTraces{traces: map[string][]tempo.Trace{realSession: {{TraceID: "aaa"}, {TraceID: "bbb"}}}, err: tracesErr}
	store, err := replay.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := evs[len(evs)-1].TS.Add(time.Minute)
	srv := New(fe, ft, store, Options{
		Now:        func() time.Time { return now },
		TraceLinks: &tempo.LinkBuilder{GrafanaURL: "http://grafana", DatasourceUID: "tempo"},
		LokiLinks:  &loki.LinkBuilder{GrafanaURL: "http://grafana", DatasourceUID: "loki"},
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, fe, at
}

func TestSessionLogs(t *testing.T) {
	ts, fe, _ := newLogsServer(t, nil)
	var resp logsResponse
	if code := getJSON(t, ts.URL+"/v1/sessions/"+realSession+"/logs", &resp); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	wantQ := `{service_name=~".+"} | session_id="` + realSession + `" or trace_id=~"00000000000000000000000000000aaa|00000000000000000000000000000bbb"`
	if resp.Query != wantQ || fe.queries[len(fe.queries)-1] != wantQ {
		t.Errorf("query %q\nwant  %q", resp.Query, wantQ)
	}
	if resp.TraceCount != 2 || !strings.Contains(resp.ExploreURL, "http://grafana/explore?") || !strings.Contains(resp.ExploreURL, "loki") {
		t.Errorf("trace count %d, explore %q", resp.TraceCount, resp.ExploreURL)
	}
	var app, backend *logLine
	for i, l := range resp.Logs {
		switch {
		case l.Body == "cart loaded":
			app = &resp.Logs[i]
		case l.Body == "request":
			backend = &resp.Logs[i]
		case l.Body == "someone else's request":
			t.Error("a line of another trace was returned")
		case l.EventName == "navigation" || l.EventName == "session.start":
			t.Errorf("timeline event %s returned as a log line", l.EventName)
		}
	}
	if app == nil || app.Source != "session" || app.Level != "warn" || app.Attrs["cart_items"] != "3" || app.Attrs["message"] != "" || app.TraceURL == "" {
		t.Errorf("app line: %+v", app)
	}
	if backend == nil || backend.Source != "trace" || backend.Service != "demo-backend" || backend.SpanID != "8ee5b22281ab2e4f" ||
		!strings.Contains(backend.TraceURL, "tempo") || backend.Attrs["trace_id"] != "" {
		t.Errorf("backend line: %+v", backend)
	}
	if resp.Count != len(resp.Logs) || resp.Truncated {
		t.Errorf("count %d of %d, truncated %v", resp.Count, len(resp.Logs), resp.Truncated)
	}
}

func TestSessionLogsWithoutTempo(t *testing.T) {
	ts, fe, _ := newLogsServer(t, errors.New("tempo down"))
	var resp logsResponse
	if code := getJSON(t, ts.URL+"/v1/sessions/"+realSession+"/logs", &resp); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if resp.TraceCount != -1 || strings.Contains(fe.queries[len(fe.queries)-1], "trace_id") {
		t.Errorf("trace count %d, query %q", resp.TraceCount, fe.queries[len(fe.queries)-1])
	}
	for _, l := range resp.Logs {
		if l.Source != "session" {
			t.Errorf("line without the session: %+v", l)
		}
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/00000000-0000-4000-8000-000000000000/logs", &resp); code != http.StatusNotFound {
		t.Errorf("unknown session: %d", code)
	}
}
