package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/audit"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/tempo"
)

var t0 = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func chunk(id string, seq int) []byte {
	b, _ := json.Marshal(map[string]any{"session_id": id, "seq": seq, "started_at": 1000, "ended_at": 2000,
		"events": []any{map[string]any{"type": 4, "timestamp": 1000}}})
	return b
}

// store returns an FS store whose clock is *clock.
func store(t *testing.T, clock *time.Time) *replay.FS {
	t.Helper()
	st, err := replay.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.Now = func() time.Time { return *clock }
	return st
}

func put(t *testing.T, st replay.Store, project, id string) {
	t.Helper()
	if _, err := st.Put(context.Background(), project, chunk(id, 0), nil); err != nil {
		t.Fatal(err)
	}
}

func ids(t *testing.T, st replay.Lister) []string {
	t.Helper()
	var out []string
	if err := st.Sessions(context.Background(), func(e replay.SessionEntry) error {
		out = append(out, e.ID)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

func TestSweeperRetentionPerProject(t *testing.T) {
	ctx := context.Background()
	clock := t0
	st := store(t, &clock)
	put(t, st, "demo", "old-demo")    // t0
	put(t, st, "ttltest", "old-ttl")  // t0
	put(t, st, "forever", "old-keep") // t0
	clock = t0.Add(20 * 24 * time.Hour)
	put(t, st, "demo", "new-demo")
	clock = t0.Add(20*24*time.Hour + 30*time.Minute)
	put(t, st, "ttltest", "new-ttl")

	// An orphan: chunk files without meta.json (interrupted upload), 2h old.
	orphan := filepath.Join(st.Root, "orphan-1")
	if err := os.MkdirAll(orphan, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(orphan, "000000.json.gz")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := t0.Add(31*24*time.Hour - 2*time.Hour)
	os.Chtimes(f, old, old)
	// A fresh orphan (upload in flight) is kept.
	fresh := filepath.Join(st.Root, "orphan-fresh")
	os.MkdirAll(fresh, 0o755)
	ff := filepath.Join(fresh, "000000.json.gz")
	os.WriteFile(ff, []byte("x"), 0o644)
	now := t0.Add(31 * 24 * time.Hour)
	os.Chtimes(ff, now.Add(-time.Minute), now.Add(-time.Minute))

	p := Policy{Default: 30 * 24 * time.Hour, Projects: map[string]time.Duration{"ttltest": time.Hour, "forever": 0}}
	sw := NewSweeper(st, p, time.Hour, nil)
	sw.Now = func() time.Time { return now }
	res, err := sw.SweepOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// old-demo (31 d > 30 d), old-ttl and new-ttl (> 1 h); old-keep has an
	// override of 0 which falls back to the default: deleted too.
	if res.Scanned != 7 || res.Expired != 4 || res.Orphans != 1 || res.Errors != 0 || res.Bytes <= 0 {
		t.Fatalf("result: %+v", res)
	}
	if got, want := ids(t, st), []string{"new-demo", "orphan-fresh"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("left: %v, want %v", got, want)
	}
	// Idempotent: a second pass over the same store deletes nothing.
	res, err = sw.SweepOnce(ctx)
	if err != nil || res.Expired+res.Orphans != 0 || res.Scanned != 2 {
		t.Fatalf("second pass: %+v %v", res, err)
	}
}

func TestSweeperKeepForever(t *testing.T) {
	clock := t0
	st := store(t, &clock)
	put(t, st, "demo", "s1")
	sw := NewSweeper(st, Policy{Default: 0}, time.Hour, nil)
	sw.Now = func() time.Time { return t0.Add(10 * 365 * 24 * time.Hour) }
	if res, err := sw.SweepOnce(context.Background()); err != nil || res.Expired != 0 {
		t.Fatalf("%+v %v", res, err)
	}
	if !st.Has(context.Background(), "s1") {
		t.Fatal("retention 0 deleted a replay")
	}
}

// failingDelete fails Delete for one session.
type failingDelete struct {
	*replay.FS
	fail string
}

func (f failingDelete) Delete(ctx context.Context, id string) error {
	if id == f.fail {
		return errors.New("disk on fire")
	}
	return f.FS.Delete(ctx, id)
}

func TestSweeperContinuesAfterADeleteError(t *testing.T) {
	clock := t0
	st := store(t, &clock)
	put(t, st, "demo", "a")
	put(t, st, "demo", "b")
	sw := NewSweeper(failingDelete{st, "a"}, Policy{Default: time.Hour}, time.Hour, nil)
	sw.Now = func() time.Time { return t0.Add(2 * time.Hour) }
	res, err := sw.SweepOnce(context.Background())
	if err != nil || res.Errors != 1 || res.Expired != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	if got := ids(t, st); !reflect.DeepEqual(got, []string{"a"}) {
		t.Fatalf("left %v", got)
	}
}

// fakeLoki answers SessionIDs from users and records Delete calls.
type fakeLoki struct {
	mu        sync.Mutex
	sessions  map[string][]string // query -> session ids
	deletes   []string
	starts    []time.Time
	deleteErr error
	findErr   error
}

func (f *fakeLoki) SessionIDs(_ context.Context, q string, start, end time.Time) (map[string]time.Time, error) {
	if f.findErr != nil {
		return nil, f.findErr
	}
	out := map[string]time.Time{}
	for _, id := range f.sessions[q] {
		out[id] = end
	}
	return out, nil
}

func (f *fakeLoki) Delete(_ context.Context, q string, start, end time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deletes = append(f.deletes, q)
	f.starts = append(f.starts, start)
	return nil
}

type fakeTempo map[string][]tempo.Trace

func (f fakeTempo) SessionTraces(_ context.Context, id string, start, end time.Time) ([]tempo.Trace, error) {
	return f[id], nil
}

func newDeleter(t *testing.T, st DeleteStore, lk *fakeLoki, log audit.Log) *Deleter {
	return NewDeleter(Deleter{Store: st, Audit: log, Logs: lk, LokiDeletes: true,
		Traces: fakeTempo{"u1-a": {{TraceID: "t1"}, {TraceID: "t2"}}, "u1-b": {{TraceID: "t2"}}},
		Now:    func() time.Time { return t0 }}, nil)
}

func TestDeleteUser(t *testing.T) {
	ctx := context.Background()
	clock := t0
	st := store(t, &clock)
	for _, s := range [][2]string{{"demo", "u1-a"}, {"demo", "u1-b"}, {"demo", "u2-a"}, {"other", "u1-other"}} {
		put(t, st, s[0], s[1])
	}
	log, err := audit.NewFile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lk := &fakeLoki{sessions: map[string][]string{
		`{service_name=~".+"} | ouo_project_id="demo" | user_id="u1"`: {"u1-a", "u1-b", "u1-other", "u1-no-replay"},
	}}
	d := newDeleter(t, st, lk, log)

	// Dry run: nothing deleted, everything counted, Loki not called.
	e, err := d.DeleteUser(ctx, Request{UserID: "u1", ProjectID: "demo", Actor: "dpo", Reason: "ticket 42", DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if e.Replays.Deleted != 2 || len(lk.deletes) != 0 || e.Loki.Status != BackendSkipped || len(ids(t, st)) != 4 {
		t.Fatalf("dry run: %+v loki=%v", e, lk.deletes)
	}

	e, err = d.DeleteUser(ctx, Request{UserID: "u1", ProjectID: "demo", Actor: "dpo", Reason: "ticket 42"})
	if err != nil {
		t.Fatal(err)
	}
	// u1-other belongs to another project: kept and not listed.
	if got := ids(t, st); !reflect.DeepEqual(got, []string{"u1-other", "u2-a"}) {
		t.Fatalf("left %v", got)
	}
	if e.Status != audit.StatusCompleted || e.SessionCount != 3 || e.Replays.Deleted != 2 || e.Replays.Bytes <= 0 ||
		!reflect.DeepEqual(e.Sessions, []string{"u1-a", "u1-b", "u1-no-replay"}) {
		t.Fatalf("entry: %+v", e)
	}
	if e.Loki.Status != BackendSubmitted || !reflect.DeepEqual(lk.deletes, []string{`{service_name=~".+"} | ouo_project_id="demo" | user_id="u1"`}) {
		t.Fatalf("loki: %+v %v", e.Loki, lk.deletes)
	}
	// Loki refuses a zero start and shards by day: the window is the log retention plus a day.
	if want := t0.Add(-720*time.Hour - 24*time.Hour); !lk.starts[0].Equal(want) {
		t.Fatalf("loki delete start %s, want %s", lk.starts[0], want)
	}
	if e.Tempo.Status != BackendManual || !reflect.DeepEqual(e.Tempo.TraceIDs, []string{"t1", "t2"}) {
		t.Fatalf("tempo: %+v", e.Tempo)
	}

	entries, _ := log.List(ctx, 0)
	if len(entries) != 4 {
		t.Fatalf("audit has %d entries, want 4 (dry run and real, started and completed each)", len(entries))
	}
	if entries[2].Status != audit.StatusStarted || entries[3].Status != audit.StatusCompleted || entries[2].ID != entries[3].ID ||
		entries[3].Actor != "dpo" || entries[3].Reason != "ticket 42" || entries[3].UserID != "u1" || entries[0].ID == entries[2].ID {
		t.Fatalf("audit entries: %+v", entries)
	}
	if _, err := log.Verify(); err != nil {
		t.Fatal(err)
	}

	// Again: idempotent, nothing left to delete, still audited.
	e, err = d.DeleteUser(ctx, Request{UserID: "u1", ProjectID: "demo", Actor: "dpo"})
	if err != nil || e.Replays.Deleted != 0 || e.Status != audit.StatusCompleted {
		t.Fatalf("second delete: %+v %v", e, err)
	}
}

// brokenLog fails every append.
type brokenLog struct{}

func (brokenLog) Append(context.Context, audit.Entry) error {
	return errors.New("read-only file system")
}
func (brokenLog) List(context.Context, int) ([]audit.Entry, error) {
	return nil, nil
}

func TestDeletionRefusedWithoutAudit(t *testing.T) {
	clock := t0
	st := store(t, &clock)
	put(t, st, "demo", "u1-a")
	lk := &fakeLoki{sessions: map[string][]string{`{service_name=~".+"} | user_id="u1"`: {"u1-a"}}}
	d := newDeleter(t, st, lk, brokenLog{})
	if _, err := d.DeleteUser(context.Background(), Request{UserID: "u1"}); !errors.Is(err, ErrAudit) {
		t.Fatalf("err = %v, want ErrAudit", err)
	}
	if _, err := d.DeleteProject(context.Background(), Request{ProjectID: "demo"}); !errors.Is(err, ErrAudit) {
		t.Fatalf("err = %v, want ErrAudit", err)
	}
	if !st.Has(context.Background(), "u1-a") || len(lk.deletes) != 0 {
		t.Fatal("deleted without an audit entry")
	}
}

func TestDeleteUserLokiFailureIsAudited(t *testing.T) {
	ctx := context.Background()
	clock := t0
	st := store(t, &clock)
	put(t, st, "demo", "u1-a")
	log, _ := audit.NewFile(t.TempDir())
	lk := &fakeLoki{sessions: map[string][]string{`{service_name=~".+"} | user_id="u1"`: {"u1-a"}},
		deleteErr: errors.New("400 Bad Request: Retention is not enabled")}
	d := newDeleter(t, st, lk, log)
	e, err := d.DeleteUser(ctx, Request{UserID: "u1"})
	if err == nil || e.Status != audit.StatusFailed || e.Loki.Status != BackendFailed || !strings.Contains(e.Error, "Retention is not enabled") {
		t.Fatalf("%+v %v", e, err)
	}
	// The replay is gone all the same: the failure is Loki's alone.
	if st.Has(ctx, "u1-a") || e.Replays.Deleted != 1 {
		t.Fatalf("replay not deleted: %+v", e)
	}
	entries, _ := log.List(ctx, 0)
	if len(entries) != 2 || entries[1].Status != audit.StatusFailed {
		t.Fatalf("audit: %+v", entries)
	}

	// The session lookup failing deletes nothing.
	lk.findErr = errors.New("loki down")
	put(t, st, "demo", "u1-b")
	if e, err := d.DeleteUser(ctx, Request{UserID: "u1"}); err == nil || e.Status != audit.StatusFailed || !st.Has(ctx, "u1-b") {
		t.Fatalf("%+v %v", e, err)
	}
}

func TestDeleteProject(t *testing.T) {
	ctx := context.Background()
	clock := t0
	st := store(t, &clock)
	for _, s := range [][2]string{{"acme", "a1"}, {"acme", "a2"}, {"demo", "d1"}} {
		put(t, st, s[0], s[1])
	}
	log, _ := audit.NewFile(t.TempDir())
	lk := &fakeLoki{}
	d := newDeleter(t, st, lk, log)
	e, err := d.DeleteProject(ctx, Request{ProjectID: "acme", Actor: "ops"})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(t, st); !reflect.DeepEqual(got, []string{"d1"}) {
		t.Fatalf("left %v", got)
	}
	if e.Action != ActionDeleteProject || e.SessionCount != 2 || e.Replays.Deleted != 2 || e.Tempo.Status != BackendUnsupported ||
		!reflect.DeepEqual(lk.deletes, []string{`{service_name=~".+"} | ouo_project_id="acme"`}) {
		t.Fatalf("%+v loki=%v", e, lk.deletes)
	}
	if e.SourceMaps != nil {
		t.Errorf("sourcemaps = %+v without a source-map store", e.SourceMaps)
	}

	maps := &fakeMaps{n: 3}
	d.SourceMaps = maps
	if e, err = d.DeleteProject(ctx, Request{ProjectID: "demo", DryRun: true}); err != nil || e.SourceMaps.Deleted != 3 || maps.deleted != "" {
		t.Fatalf("dry run: %+v %v, deleted %q", e.SourceMaps, err, maps.deleted)
	}
	if e, err = d.DeleteProject(ctx, Request{ProjectID: "demo"}); err != nil || e.SourceMaps.Deleted != 3 || maps.deleted != "demo" {
		t.Fatalf("delete: %+v %v, deleted %q", e.SourceMaps, err, maps.deleted)
	}
}

type fakeMaps struct {
	n       int
	deleted string
}

func (f *fakeMaps) CountProject(_ context.Context, p string) (int, error) { return f.n, nil }
func (f *fakeMaps) DeleteProject(_ context.Context, p string) (int, error) {
	f.deleted = p
	return f.n, nil
}

func TestPolicy(t *testing.T) {
	p := Policy{Default: 30 * 24 * time.Hour, Projects: map[string]time.Duration{"ttl": time.Hour}}
	if p.For("ttl") != time.Hour || p.For("demo") != 30*24*time.Hour {
		t.Fatal(p)
	}
	all := p.All()
	sort.Slice(all, func(i, j int) bool { return all[i] < all[j] })
	if !reflect.DeepEqual(all, []time.Duration{time.Hour, 30 * 24 * time.Hour}) {
		t.Fatal(all)
	}
}
