package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeLoki answers every query_range with the given streams (newest first, as a backward query).
func fakeLoki(t *testing.T, streams ...map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/loki/api/v1/query_range") {
			http.NotFound(w, r)
			return
		}
		if q := r.URL.Query().Get("query"); !strings.Contains(q, `event_name="exception"`) {
			t.Errorf("query %q does not select exceptions", q)
		}
		var result []any
		now := time.Now()
		for i, s := range streams {
			ts := strconv.FormatInt(now.Add(-time.Duration(i)*time.Second).UnixNano(), 10)
			result = append(result, map[string]any{"stream": s, "values": [][]string{{ts, "exception"}}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": result}})
	}))
}

func TestNewestMatchingRecord(t *testing.T) {
	stack := "Error: boom\n  at f (app:///index.android.bundle:1:10) [in app]"
	loki := fakeLoki(t,
		map[string]string{"ouo_project_id": "demo", "event_name": "exception", "exception_message": "other", "exception_stacktrace": "Error: other"},
		map[string]string{"ouo_project_id": "demo", "event_name": "exception", "exception_message": "boom", "exception_stacktrace": stack, "service_version": "1.0.0"},
	)
	defer loki.Close()
	muninn := httptest.NewServer(http.NotFoundHandler()) // no debug files: the frame stays as recorded
	defer muninn.Close()

	if err := run(context.Background(), []string{"--loki", loki.URL, "--muninn", muninn.URL, "--project", "demo", "--contains", "boom"}); err != nil {
		t.Fatalf("run: %v", err)
	}
	err := run(context.Background(), []string{"--loki", loki.URL, "--muninn", muninn.URL, "--project", "demo", "--contains", "absent"})
	if err == nil || !strings.Contains(err.Error(), "no exception record") {
		t.Fatalf("want no-record error, got %v", err)
	}
	if err := run(context.Background(), []string{"--loki", loki.URL}); err == nil {
		t.Fatal("missing flags accepted")
	}
}
