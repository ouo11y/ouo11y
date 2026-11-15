package ouogo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// adminMuninn fakes Muninn's delete and audit routes (spec sections 8 and 14).
type adminMuninn struct {
	mu      sync.Mutex
	deletes []string
	audit   map[string][]byte // entry/status -> body
	order   []string
}

func (f *adminMuninn) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+readTok || r.Header.Get("X-Scope-OrgID") != "acme" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodDelete && r.URL.Path == "/api/v1/projects/"+proj+"/sessions/"+sess+"/replays":
		f.deletes = append(f.deletes, r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodDelete && r.URL.Path == "/api/v1/projects/"+proj:
		f.deletes = append(f.deletes, r.URL.Path)
		_, _ = w.Write([]byte(`{"replays":3,"debug_files":2}`))
	case r.Method == http.MethodPut && len(r.URL.Path) > len("/api/v1/audit/"):
		key := r.URL.Path[len("/api/v1/audit/"):]
		body, _ := io.ReadAll(r.Body)
		if old, ok := f.audit[key]; ok {
			if bytes.Equal(old, body) {
				w.WriteHeader(http.StatusOK)
			} else {
				w.WriteHeader(http.StatusConflict)
			}
			return
		}
		f.audit[key] = body
		f.order = append(f.order, key)
		w.WriteHeader(http.StatusCreated)
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/audit":
		want := r.URL.Query().Get("entry")
		out := []AuditRecord{}
		for _, k := range f.order {
			entry, status := k[:25], k[26:]
			if want == "" || want == entry {
				out = append(out, AuditRecord{Entry: entry, Status: status, Record: f.audit[k]})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"entries": out})
	default:
		http.Error(w, `{"error":"no route"}`, http.StatusNotFound)
	}
}

func newAdmin(t *testing.T) (*Muninn, *adminMuninn) {
	f := &adminMuninn{audit: map[string][]byte{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return &Muninn{URL: srv.URL, Tenant: "acme", ReadToken: readTok}, f
}

func TestAdminDelete(t *testing.T) {
	m, f := newAdmin(t)
	ctx := context.Background()
	if err := m.DeleteSessionReplays(ctx, proj, sess); err != nil {
		t.Fatal(err)
	}
	c, err := m.DeleteProject(ctx, proj)
	if err != nil {
		t.Fatal(err)
	}
	if c != (ProjectDeleteCounts{Replays: 3, DebugFiles: 2}) {
		t.Fatalf("counts %+v", c)
	}
	if len(f.deletes) != 2 {
		t.Fatalf("deletes %v", f.deletes)
	}
	var bad *BadRequestError
	if err := m.DeleteSessionReplays(ctx, proj, "not-hex"); !errors.As(err, &bad) {
		t.Fatalf("bad session: %v", err)
	}
	if _, err := m.DeleteProject(ctx, "../x"); !errors.As(err, &bad) {
		t.Fatalf("bad project: %v", err)
	}
	var be *BackendError
	if _, err := m.DeleteProject(ctx, "other"); !errors.As(err, &be) {
		t.Fatalf("404 project: %v", err)
	}
	m.ReadToken = "wrong"
	if err := m.DeleteSessionReplays(ctx, proj, sess); !errors.As(err, &be) {
		t.Fatalf("401: %v", err)
	}
}

func TestAuditPutAndList(t *testing.T) {
	m, _ := newAdmin(t)
	ctx := context.Background()
	const entry = "20261114T101500Z-1a2b3c4d"
	rec := map[string]any{"action": "delete_user", "status": "started"}
	if err := m.PutAudit(ctx, entry, AuditStarted, rec); err != nil {
		t.Fatal(err)
	}
	// AUD-2: same bytes again answer 200.
	if err := m.PutAudit(ctx, entry, AuditStarted, rec); err != nil {
		t.Fatalf("same bytes: %v", err)
	}
	// Other bytes: 409 surfaced as a typed error.
	var conflict *AuditConflictError
	if err := m.PutAudit(ctx, entry, AuditStarted, map[string]any{"x": 1}); !errors.As(err, &conflict) || conflict.Entry != entry {
		t.Fatalf("conflict: %v", err)
	}
	if err := m.PutAudit(ctx, entry, AuditCompleted, map[string]any{"status": "completed"}); err != nil {
		t.Fatal(err)
	}
	if err := m.PutAudit(ctx, "20261114T101600Z-ffffffff", AuditFailed, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	all, err := m.Audit(ctx, "")
	if err != nil || len(all) != 3 {
		t.Fatalf("all: %v %+v", err, all)
	}
	one, err := m.Audit(ctx, entry)
	if err != nil || len(one) != 2 || one[0].Status != AuditStarted || one[1].Status != AuditCompleted {
		t.Fatalf("one: %v %+v", err, one)
	}
	var got map[string]any
	if err := json.Unmarshal(one[0].Record, &got); err != nil || got["action"] != "delete_user" {
		t.Fatalf("record %s", one[0].Record)
	}
}

func TestAuditValidation(t *testing.T) {
	m, _ := newAdmin(t)
	ctx := context.Background()
	var bad *BadRequestError
	for _, c := range []struct{ entry, status string }{
		{"20261114T101500Z-1a2b3c4", AuditStarted},
		{"2026-11-14T10:15:00Z-1a2b3c4d", AuditStarted},
		{"20261114T101500Z-1a2b3c4d", "done"},
	} {
		if err := m.PutAudit(ctx, c.entry, c.status, map[string]any{}); !errors.As(err, &bad) {
			t.Errorf("%s/%s: %v", c.entry, c.status, err)
		}
	}
	if err := m.PutAudit(ctx, "20261114T101500Z-1a2b3c4d", AuditStarted, []int{1}); !errors.As(err, &bad) {
		t.Errorf("non-object: %v", err)
	}
	big := map[string]string{"x": string(bytes.Repeat([]byte("a"), MaxAuditRecord))}
	if err := m.PutAudit(ctx, "20261114T101500Z-1a2b3c4d", AuditStarted, big); !errors.As(err, &bad) {
		t.Errorf("too big: %v", err)
	}
	if _, err := m.Audit(ctx, "x&entry=y"); !errors.As(err, &bad) {
		t.Errorf("bad list entry: %v", err)
	}
}
