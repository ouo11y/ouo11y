package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/audit"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/lifecycle"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/sampling"
)

type adminLoki struct{ deletes []string }

func (a *adminLoki) SessionIDs(_ context.Context, q string, start, end time.Time) (map[string]time.Time, error) {
	if strings.Contains(q, `user_id="u1"`) {
		return map[string]time.Time{"adm-1": end}, nil
	}
	return nil, nil
}

func (a *adminLoki) Delete(_ context.Context, q string, start, end time.Time) error {
	a.deletes = append(a.deletes, q)
	return nil
}

func newAdminServer(t *testing.T, adminToken string) (*httptest.Server, *replay.FS, *adminLoki) {
	t.Helper()
	store, err := replay.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	log, err := audit.NewFile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lk := &adminLoki{}
	d := lifecycle.NewDeleter(lifecycle.Deleter{Store: store, Audit: log, Logs: lk, LokiDeletes: true}, nil)
	sw := lifecycle.NewSweeper(store, lifecycle.Policy{Default: time.Hour}, time.Hour, nil)
	srv := New(&fakeEvents{}, &fakeTraces{}, store, Options{
		ReadToken: "rt", IngestToken: "it", AdminToken: adminToken,
		Admin:    &Admin{Deleter: d, Sweeper: sw, Audit: log},
		Sampling: map[string]SamplingRates{"capped": {SessionRate: 1, ReplayRate: 0.5}},
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, store, lk
}

func call(t *testing.T, method, url, token string, v any) int {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set(ActorHeader, "dpo@example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if v != nil {
		json.NewDecoder(resp.Body).Decode(v)
	}
	return resp.StatusCode
}

func TestAdminAuth(t *testing.T) {
	ts, _, _ := newAdminServer(t, "at")
	for _, c := range []struct {
		token string
		want  int
	}{{"", 401}, {"rt", 401}, {"it", 401}, {"at", 200}} {
		if got := call(t, http.MethodGet, ts.URL+"/v1/admin/audit", c.token, nil); got != c.want {
			t.Errorf("token %q: %d, want %d", c.token, got, c.want)
		}
	}
	// The admin token does not open the read API.
	if got := call(t, http.MethodGet, ts.URL+"/v1/sessions", "at", nil); got != 401 {
		t.Errorf("read API with the admin token: %d", got)
	}

	off, _, _ := newAdminServer(t, "")
	if got := call(t, http.MethodDelete, off.URL+"/v1/admin/users/u1", "rt", nil); got != 404 {
		t.Errorf("admin API without a token: %d, want 404", got)
	}
}

func TestAdminDeleteUserAndAudit(t *testing.T) {
	ts, store, lk := newAdminServer(t, "at")
	ctx := context.Background()
	if _, err := store.Put(ctx, "demo", []byte(`{"session_id":"adm-1","seq":0,"started_at":1,"ended_at":2,"events":[{"type":4,"timestamp":1}]}`), nil); err != nil {
		t.Fatal(err)
	}
	if got := call(t, http.MethodDelete, ts.URL+"/v1/admin/users/u1?dry_run=maybe", "at", nil); got != 400 {
		t.Fatalf("bad dry_run: %d", got)
	}
	var e audit.Entry
	if got := call(t, http.MethodDelete, ts.URL+"/v1/admin/users/u1?reason=gdpr-17&project=demo", "at", &e); got != 200 {
		t.Fatalf("delete user: %d", got)
	}
	if e.Status != audit.StatusCompleted || e.Actor != "dpo@example.com" || e.Reason != "gdpr-17" || e.Replays.Deleted != 1 || store.Has(ctx, "adm-1") {
		t.Fatalf("entry %+v", e)
	}
	if len(lk.deletes) != 1 || lk.deletes[0] != `{service_name=~".+"} | ouo_project_id="demo" | user_id="u1"` {
		t.Fatalf("loki %v", lk.deletes)
	}
	var list struct{ Entries []audit.Entry }
	if got := call(t, http.MethodGet, ts.URL+"/v1/admin/audit?limit=10", "at", &list); got != 200 || len(list.Entries) != 2 ||
		list.Entries[0].Status != audit.StatusStarted || list.Entries[1].ID != e.ID {
		t.Fatalf("audit %d %+v", got, list)
	}

	var p audit.Entry
	if got := call(t, http.MethodDelete, ts.URL+"/v1/admin/projects/Bad!", "at", nil); got != 400 {
		t.Fatalf("bad project: %d", got)
	}
	if got := call(t, http.MethodDelete, ts.URL+"/v1/admin/projects/demo", "at", &p); got != 200 || p.Action != lifecycle.ActionDeleteProject {
		t.Fatalf("delete project %d %+v", got, p)
	}
}

func TestAdminSweep(t *testing.T) {
	ts, store, _ := newAdminServer(t, "at")
	store.Now = func() time.Time { return time.Now().Add(-2 * time.Hour) }
	store.Put(context.Background(), "demo", []byte(`{"session_id":"old","seq":0,"started_at":1,"ended_at":2,"events":[{"type":4,"timestamp":1}]}`), nil)
	var res lifecycle.SweepResult
	if got := call(t, http.MethodPost, ts.URL+"/v1/admin/retention/sweep", "at", &res); got != 200 || res.Expired != 1 {
		t.Fatalf("sweep %d %+v", got, res)
	}
}

func TestSinkSamplingCap(t *testing.T) {
	ts, store, _ := newAdminServer(t, "at")
	var in, out string
	for i := 0; in == "" || out == ""; i++ {
		id := "cap-" + string(rune('a'+i%26)) + strings.Repeat("x", i/26)
		if sampling.Sampled(id, 0.5, sampling.Replay) {
			in = id
		} else {
			out = id
		}
	}
	post := func(project, id string) map[string]any {
		body := `{"session_id":"` + id + `","seq":0,"started_at":1,"ended_at":2,"events":[{"type":4,"timestamp":1}]}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/replay/chunks", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer it")
		req.Header.Set(ProjectIDHeader, project)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("%s/%s: %d", project, id, resp.StatusCode)
		}
		var v map[string]any
		json.NewDecoder(resp.Body).Decode(&v)
		return v
	}
	ctx := context.Background()
	if v := post("capped", out); v["sampled_out"] != true || store.Has(ctx, out) {
		t.Fatalf("out of sample stored: %v", v)
	}
	if v := post("capped", in); v["accepted"] != true || !store.Has(ctx, in) {
		t.Fatalf("in sample dropped: %v", v)
	}
	// Other projects have no cap.
	other := out + "-other"
	if v := post("demo", other); v["accepted"] != true {
		t.Fatalf("uncapped project: %v", v)
	}
}
