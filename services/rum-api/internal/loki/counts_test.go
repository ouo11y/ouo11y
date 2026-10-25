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
