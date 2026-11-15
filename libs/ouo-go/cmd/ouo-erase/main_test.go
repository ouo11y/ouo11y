package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// backend fakes Loki and Muninn on one server (their paths do not overlap).
type backend struct {
	mu       sync.Mutex
	calls    []string
	audit    map[string][]byte
	order    []string
	failLoki bool
}

func (b *backend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls = append(b.calls, r.Method+" "+r.URL.Path)
	p := r.URL.Path
	switch {
	case p == "/loki/api/v1/query":
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"ouo_project_id":"demo","session_id":"0123456789abcdef0123456789abcdef"},"value":[1,"2"]}]}}`)
	case p == "/loki/api/v1/delete":
		if b.failLoki {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case r.Header.Get("Authorization") != "Bearer secret":
		w.WriteHeader(http.StatusUnauthorized)
	case strings.HasPrefix(p, "/api/v1/audit/") && r.Method == http.MethodPut:
		key := strings.TrimPrefix(p, "/api/v1/audit/")
		body, _ := io.ReadAll(r.Body)
		b.audit[key] = body
		b.order = append(b.order, key)
		w.WriteHeader(http.StatusCreated)
	case p == "/api/v1/audit":
		var entries []map[string]any
		for _, k := range b.order {
			e, s, _ := strings.Cut(k, "/")
			entries = append(entries, map[string]any{"entry": e, "status": s, "record": json.RawMessage(b.audit[k])})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"entries": entries})
	case strings.HasSuffix(p, "/replays") && r.Method == http.MethodGet:
		_, _ = io.WriteString(w, `{"replays":[{"replay_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byte_size":10}]}`)
	case strings.HasSuffix(p, "/replays") && r.Method == http.MethodDelete:
		w.WriteHeader(http.StatusNoContent)
	case p == "/api/v1/projects/demo" && r.Method == http.MethodDelete:
		_, _ = io.WriteString(w, `{"replays":5,"debug_files":1}`)
	default:
		http.NotFound(w, r)
	}
}

func setup(t *testing.T) (*backend, func(args ...string) (int, string, string)) {
	b := &backend{audit: map[string][]byte{}}
	srv := httptest.NewServer(b)
	t.Cleanup(srv.Close)
	env := map[string]string{
		"OUO_LOKI_URL": srv.URL, "OUO_MUNINN_URL": srv.URL, "MUNINN_ADMIN_TOKEN": "secret", "USER": "ops",
	}
	return b, func(args ...string) (int, string, string) {
		var out, errOut bytes.Buffer
		code := run(context.Background(), args, func(k string) string { return env[k] }, &out, &errOut)
		return code, out.String(), errOut.String()
	}
}

func TestUserCommand(t *testing.T) {
	b, run := setup(t)
	code, out, stderr := run("user", "u1", "--project", "demo", "--reason", "GDPR #1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(out), &rec); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if rec["status"] != "completed" || rec["actor"] != "ops" || rec["reason"] != "GDPR #1" || rec["project_id"] != "demo" {
		t.Fatalf("record %v", rec)
	}
	if tempo := rec["tempo"].(map[string]any); tempo["status"] != "skipped" {
		t.Fatalf("tempo without URL: %v", tempo)
	}
	if len(b.order) != 2 {
		t.Fatalf("audit %v", b.order)
	}
}

func TestDryRunAndFlagsFirst(t *testing.T) {
	b, run := setup(t)
	code, out, _ := run("project", "--dry-run", "--actor", "dpo", "demo")
	if code != 0 || !strings.Contains(out, `"dry_run": true`) || !strings.Contains(out, `"actor": "dpo"`) {
		t.Fatalf("exit %d: %s", code, out)
	}
	for _, c := range b.calls {
		if strings.HasPrefix(c, "DELETE") || strings.HasSuffix(c, "/loki/api/v1/delete") {
			t.Fatalf("dry run called %s", c)
		}
	}
}

func TestFailureExitsOne(t *testing.T) {
	b, run := setup(t)
	b.failLoki = true
	code, out, stderr := run("project", "demo")
	if code != 1 || !strings.Contains(out, `"status": "failed"`) || !strings.Contains(out, `"replays": {`) || !strings.Contains(stderr, "loki") {
		t.Fatalf("exit %d\n%s\n%s", code, out, stderr)
	}
	// No token: the started record is refused, nothing is deleted.
	_, run2 := setup(t)
	code, _, stderr = run2("project", "demo", "--muninn-url", "http://127.0.0.1:1")
	if code != 1 || !strings.Contains(stderr, "nothing was deleted") {
		t.Fatalf("exit %d: %s", code, stderr)
	}
}

func TestAuditCommand(t *testing.T) {
	_, run := setup(t)
	if code, _, stderr := run("user", "u1"); code != 0 {
		t.Fatal(stderr)
	}
	code, out, stderr := run("audit")
	if code != 0 {
		t.Fatal(stderr)
	}
	var a struct {
		Entries []struct{ Entry, Status string }
	}
	if err := json.Unmarshal([]byte(out), &a); err != nil || len(a.Entries) != 2 || a.Entries[1].Status != "completed" {
		t.Fatalf("%v %s", err, out)
	}
}

func TestUsage(t *testing.T) {
	_, run := setup(t)
	for _, args := range [][]string{{}, {"nope"}, {"user"}, {"project", "a", "b"}, {"audit", "x"}, {"user", "u", "--bogus"}} {
		if code, _, _ := run(args...); code != 2 {
			t.Errorf("%v: exit %d", args, code)
		}
	}
}
