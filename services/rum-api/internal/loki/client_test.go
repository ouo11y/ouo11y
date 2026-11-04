package loki

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

func TestFiltersQuery(t *testing.T) {
	cases := []struct {
		f    Filters
		want string
	}{
		{Filters{}, `{service_name=~".+", event_name=~".+"}`},
		{Filters{Platform: "web", Service: "web-store"}, `{service_name="web-store", event_name=~".+", ouo_platform="web"}`},
		{Filters{Version: "1.0", User: "u\"1", SessionID: "s1"}, `{service_name=~".+", event_name=~".+"} | session_id="s1" | service_version="1.0" | user_id="u\"1"`},
		{Filters{EventNames: []string{"session.start", "exception"}}, `{service_name=~".+", event_name=~"session.start|exception"}`},
	}
	for _, c := range cases {
		if got := c.f.Query(); got != c.want {
			t.Errorf("got  %s\nwant %s", got, c.want)
		}
	}
}

// TestEventsPagination serves 3 entries per page and checks the client
// walks forward until a short page, de-duplicating the inclusive boundary.
func TestEventsPagination(t *testing.T) {
	base := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	total := 7
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" {
			w.Write([]byte("ready"))
			return
		}
		q := r.URL.Query()
		calls = append(calls, q.Get("start"))
		start, _ := strconv.ParseInt(q.Get("start"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		var streams []session.LokiStream
		n := 0
		for i := 0; i < total && n < limit; i++ {
			ts := base.Add(time.Duration(i) * time.Second).UnixNano()
			if ts < start {
				continue
			}
			streams = append(streams, session.LokiStream{
				Stream: map[string]string{"event_name": "navigation", "session_id": "s", "service_name": "x", "ouo_platform": "web"},
				Values: [][2]string{{strconv.FormatInt(ts, 10), fmt.Sprintf("line %d", i)}},
			})
			n++
		}
		json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": streams}})
	}))
	defer srv.Close()

	c := New(srv.URL, srv.Client())
	c.PageLimit = 3
	if err := c.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	evs, err := c.Events(context.Background(), Filters{}, base, base.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != total {
		t.Fatalf("got %d events want %d (calls %v)", len(evs), total, calls)
	}
	for i, ev := range evs {
		if ev.Line != fmt.Sprintf("line %d", i) {
			t.Fatalf("order/dedupe broken at %d: %q", i, ev.Line)
		}
	}
	// pages: [0,1,2] [2,3,4] [4,5,6] [6] -> 4 calls
	if len(calls) != 4 {
		t.Fatalf("expected 4 pages, got %d: %v", len(calls), calls)
	}
}

func TestEventsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "parse error", http.StatusBadRequest)
	}))
	defer srv.Close()
	_, err := New(srv.URL, srv.Client()).Events(context.Background(), Filters{}, time.Now().Add(-time.Hour), time.Now())
	if err == nil {
		t.Fatal("expected error")
	}
}

// TestEventsQueryCapped: a read that ends on a full last page reports that it
// was cut at PageLimit × MaxPages (docs/specs/funnels.md, truncated).
func TestEventsQueryCapped(t *testing.T) {
	base := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	total := 7
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		start, _ := strconv.ParseInt(q.Get("start"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		var streams []session.LokiStream
		for i := 0; i < total && len(streams) < limit; i++ {
			ts := base.Add(time.Duration(i) * time.Second).UnixNano()
			if ts < start {
				continue
			}
			streams = append(streams, session.LokiStream{
				Stream: map[string]string{"event_name": "navigation", "session_id": "s"},
				Values: [][2]string{{strconv.FormatInt(ts, 10), fmt.Sprintf("line %d", i)}},
			})
		}
		json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": streams}})
	}))
	defer srv.Close()

	c := New(srv.URL, srv.Client())
	c.PageLimit = 3
	for _, tc := range []struct {
		pages, events int
		truncated     bool
	}{{2, 5, true}, {4, 7, false}, {9, 7, false}} {
		c.MaxPages = tc.pages
		evs, truncated, err := c.EventsQueryCapped(context.Background(), `{event_name="navigation"}`, base, base.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if len(evs) != tc.events || truncated != tc.truncated {
			t.Errorf("MaxPages %d: %d events truncated %v, want %d %v", tc.pages, len(evs), truncated, tc.events, tc.truncated)
		}
	}
}
