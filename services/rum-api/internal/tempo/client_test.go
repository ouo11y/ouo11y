package tempo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const sample = `{"traces":[
 {"traceID":"aaa","rootServiceName":"web-store","rootTraceName":"documentLoad","startTimeUnixNano":"1791263200697399903","durationMs":48,
  "spanSet":{"matched":4},"serviceStats":{"web-store":{"spanCount":4}}},
 {"traceID":"bbb","rootServiceName":"web-store","rootTraceName":"GET","startTimeUnixNano":"1791263181463000000","durationMs":6,
  "spanSet":{"matched":2},"serviceStats":{"demo-backend":{"spanCount":1},"web-store":{"spanCount":1}}}
]}`

const errSample = `{"traces":[{"traceID":"bbb","rootServiceName":"web-store","rootTraceName":"GET","startTimeUnixNano":"1791263181463000000","durationMs":6}]}`

func TestSessionTraces(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		q := r.URL.Query()
		if q.Get("start") == "" || q.Get("end") == "" {
			t.Errorf("start/end missing: %s", r.URL.String())
		}
		if !strings.Contains(q.Get("q"), `span.session.id = "s1"`) {
			t.Errorf("unexpected q %q", q.Get("q"))
		}
		if strings.Contains(q.Get("q"), "status = error") {
			w.Write([]byte(errSample))
			return
		}
		w.Write([]byte(sample))
	}))
	defer srv.Close()

	c := New(srv.URL, srv.Client(), 2, time.Minute)
	c.Links = &LinkBuilder{GrafanaURL: "http://localhost:3000/", DatasourceUID: "tempo"}
	start, end := time.Unix(1791263000, 0), time.Unix(1791264000, 0)
	traces, err := c.SessionTraces(context.Background(), "s1", start, end)
	if err != nil {
		t.Fatal(err)
	}
	if len(traces) != 2 || traces[0].TraceID != "aaa" || traces[1].TraceID != "bbb" {
		t.Fatalf("traces: %+v", traces)
	}
	if traces[0].SpanCount != 4 || traces[1].SpanCount != 2 || traces[0].HasError || !traces[1].HasError {
		t.Fatalf("span counts / errors: %+v", traces)
	}
	if traces[0].RootName != "documentLoad" || traces[0].DurationMs != 48 || traces[0].Start.Unix() != 1791263200 {
		t.Fatalf("fields: %+v", traces[0])
	}
	u, err := url.Parse(traces[0].GrafanaURL)
	if err != nil || u.Path != "/explore" || u.Query().Get("schemaVersion") != "1" {
		t.Fatalf("grafana url: %s", traces[0].GrafanaURL)
	}
	var panes map[string]map[string]any
	if err := json.Unmarshal([]byte(u.Query().Get("panes")), &panes); err != nil {
		t.Fatalf("panes not json: %v", err)
	}
	pane := panes["ouo"]
	if pane["datasource"] != "tempo" {
		t.Fatalf("pane datasource: %v", pane)
	}
	qs := pane["queries"].([]any)[0].(map[string]any)
	if qs["query"] != "aaa" || qs["queryType"] != "traceql" {
		t.Fatalf("pane query: %v", qs)
	}

	// Second call within TTL hits the cache: no new HTTP calls.
	before := atomic.LoadInt32(&calls)
	if _, err := c.SessionTraces(context.Background(), "s1", start, end); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&calls) != before {
		t.Fatalf("cache miss: %d -> %d", before, calls)
	}
}

func TestSessionTracesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := New(srv.URL, srv.Client(), 1, 0)
	if _, err := c.SessionTraces(context.Background(), "s1", time.Now().Add(-time.Hour), time.Now()); err == nil {
		t.Fatal("expected error")
	}
}
