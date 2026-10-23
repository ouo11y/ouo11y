package loki

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSubjectFilter(t *testing.T) {
	for _, c := range [][3]string{
		{"u1", "", `{service_name=~".+"} | user_id="u1"`},
		{"", "acme", `{service_name=~".+"} | ouo_project_id="acme"`},
		{`u"1`, "acme", `{service_name=~".+"} | ouo_project_id="acme" | user_id="u\"1"`},
	} {
		if got := SubjectFilter(c[0], c[1]); got != c[2] {
			t.Errorf("got %s want %s", got, c[2])
		}
	}
}

func TestSessionIDsWindows(t *testing.T) {
	end := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	var queries []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/loki/api/v1/query" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		queries = append(queries, r.URL.Query().Get("query"))
		n := len(queries)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch n {
		case 1:
			w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"session_id":"s1"},"value":[1,"3"]},{"metric":{"session_id":"s2"},"value":[1,"1"]}]}}`))
		case 2:
			w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"session_id":"s2"},"value":[1,"5"]},{"metric":{},"value":[1,"1"]}]}}`))
		default:
			w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
		}
	}))
	defer srv.Close()
	c := New(srv.URL, nil)
	got, err := c.SessionIDs(context.Background(), SubjectFilter("u1", ""), end.Add(-60*time.Hour), end)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !got["s1"].Equal(end) || !got["s2"].Equal(end) {
		t.Fatalf("got %v", got)
	}
	// 60 h = 24 h + 24 h + 12 h.
	want := []string{
		`sum by (session_id) (count_over_time({service_name=~".+"} | user_id="u1" [86400s]))`,
		`sum by (session_id) (count_over_time({service_name=~".+"} | user_id="u1" [86400s]))`,
		`sum by (session_id) (count_over_time({service_name=~".+"} | user_id="u1" [43200s]))`,
	}
	if strings.Join(queries, "\n") != strings.Join(want, "\n") {
		t.Fatalf("queries:\n%s", strings.Join(queries, "\n"))
	}
}

func TestDelete(t *testing.T) {
	var got *http.Request
	status := http.StatusNoContent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		if status != http.StatusNoContent {
			http.Error(w, "Retention is not enabled", status)
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()
	c := New(srv.URL, nil)
	end := time.Unix(1_800_000_000, 0)
	if err := c.Delete(context.Background(), `{service_name=~".+"} | user_id="u1"`, time.Unix(0, 0), end); err != nil {
		t.Fatal(err)
	}
	q := got.URL.Query()
	if got.Method != http.MethodPost || got.URL.Path != "/loki/api/v1/delete" || q.Get("query") != `{service_name=~".+"} | user_id="u1"` ||
		q.Get("start") != "0" || q.Get("end") != "1800000001" {
		t.Fatalf("request %s %s", got.Method, got.URL)
	}
	status = http.StatusBadRequest
	if err := c.Delete(context.Background(), "{}", time.Unix(0, 0), end); err == nil || !strings.Contains(err.Error(), "Retention is not enabled") {
		t.Fatalf("err = %v", err)
	}
}
