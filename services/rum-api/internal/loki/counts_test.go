package loki

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCounts(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query().Get("query")
		w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[
			{"metric":{"url_path":"/"},"value":[1,"12"]},
			{"metric":{"url_path":"/cart"},"value":[1,"3"]},
			{"metric":{},"value":[1,"7"]}]}}`))
	}))
	defer srv.Close()
	c := New(srv.URL, nil)
	end := time.Unix(7200, 0)
	m, err := c.Counts(context.Background(), `{event_name="navigation"}`, "url_path", end.Add(-time.Hour), end)
	if err != nil {
		t.Fatal(err)
	}
	if m["/"] != 12 || m["/cart"] != 3 || len(m) != 2 {
		t.Fatalf("counts %v", m)
	}
	if !strings.HasPrefix(got, `sum by (url_path) (count_over_time({event_name="navigation"} [3600s]))`) {
		t.Fatalf("query %s", got)
	}
}

func TestCountsBy(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query().Get("query")
		w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[
			{"metric":{"ouo_project_id":"shop","service_name":"web-store"},"value":[1,"12"]},
			{"metric":{"service_name":"legacy"},"value":[1,"2"]},
			{"metric":{"ouo_project_id":"bank","service_name":"bank-app"},"value":[1,"bad"]}]}}`))
	}))
	defer srv.Close()
	c := New(srv.URL, nil)
	end := time.Unix(7200, 0)
	gc, err := c.CountsBy(context.Background(), `{event_name="session.start"}`, []string{"ouo_project_id", "service_name"}, end.Add(-time.Hour), end)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, `sum by (ouo_project_id, service_name) (count_over_time({event_name="session.start"} [3600s]))`) {
		t.Fatalf("query %s", got)
	}
	if len(gc) != 2 {
		t.Fatalf("got %d series, want 2 (unparseable value dropped): %+v", len(gc), gc)
	}
	if gc[0].Count != 12 || gc[0].Labels["ouo_project_id"] != "shop" || gc[0].Labels["service_name"] != "web-store" {
		t.Fatalf("first %+v", gc[0])
	}
	if gc[1].Count != 2 || gc[1].Labels["ouo_project_id"] != "" {
		t.Fatalf("missing label must be empty: %+v", gc[1])
	}
}

func TestCountsByError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "too many", http.StatusBadRequest)
	}))
	defer srv.Close()
	end := time.Unix(7200, 0)
	if _, err := New(srv.URL, nil).CountsBy(context.Background(), `{a="b"}`, []string{"x"}, end.Add(-time.Hour), end); err == nil || !strings.Contains(err.Error(), "too many") {
		t.Fatalf("err %v", err)
	}
}
