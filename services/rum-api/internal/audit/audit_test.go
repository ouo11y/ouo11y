package audit

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func entry(id, status string, at time.Time) Entry {
	return Entry{ID: id, Time: at, Status: status, Action: "delete_user", UserID: "u1", Actor: "test"}
}

func TestFileAppendListAndChain(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	f, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	for i, st := range []string{StatusStarted, StatusCompleted, StatusStarted, StatusFailed} {
		if err := f.Append(ctx, entry([]string{"a", "a", "b", "b"}[i], st, t0.Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatal(err)
		}
	}
	all, err := f.List(ctx, 0)
	if err != nil || len(all) != 4 {
		t.Fatalf("list: %d entries, %v", len(all), err)
	}
	if all[0].Prev != "" || all[1].Prev == "" || all[0].ID != "a" || all[3].Status != StatusFailed {
		t.Fatalf("entries: %+v", all)
	}
	last2, _ := f.List(ctx, 2)
	if len(last2) != 2 || last2[0].ID != "b" || last2[1].Status != StatusFailed {
		t.Fatalf("limit 2: %+v", last2)
	}
	if n, err := f.Verify(); err != nil || n != 4 {
		t.Fatalf("verify: %d %v", n, err)
	}

	// A reopened log continues the chain.
	f2, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := f2.Append(ctx, entry("c", StatusStarted, t0.Add(time.Minute))); err != nil {
		t.Fatal(err)
	}
	if n, err := f2.Verify(); err != nil || n != 5 {
		t.Fatalf("verify after reopen: %d %v", n, err)
	}

	// Editing a line (here: the actor of the second entry) breaks the chain
	// at the line after it.
	b, _ := os.ReadFile(f.Path())
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	lines[1] = strings.Replace(lines[1], `"actor":"test"`, `"actor":"someone-else"`, 1)
	if err := os.WriteFile(f.Path(), []byte(strings.Join(lines, "\n")+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if n, err := f2.Verify(); err == nil || n != 2 || !strings.Contains(err.Error(), "line 3") {
		t.Fatalf("tampered log: %d %v", n, err)
	}
}

func TestFileConcurrentAppends(t *testing.T) {
	ctx := context.Background()
	f, err := NewFile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := f.Append(ctx, entry(strings.Repeat("x", i%7+1), StatusStarted, time.Now())); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if n, err := f.Verify(); err != nil || n != 50 {
		t.Fatalf("verify: %d %v", n, err)
	}
}

type memObjects struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func (m *memObjects) PutNew(_ context.Context, name string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.objs[name]; ok {
		return errors.New("exists")
	}
	m.objs[name] = data
	return nil
}

func (m *memObjects) Names(context.Context) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for k := range m.objs {
		out = append(out, k)
	}
	return out, nil
}

func (m *memObjects) Get(_ context.Context, name string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.objs[name], nil
}

func TestBucketOrderAndNoOverwrite(t *testing.T) {
	ctx := context.Background()
	m := &memObjects{objs: map[string][]byte{}}
	b := Bucket{Store: m}
	t0 := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	// Appended out of order: List sorts by the time in the name.
	for _, e := range []Entry{entry("b", StatusStarted, t0.Add(2*time.Second)), entry("a", StatusStarted, t0), entry("a", StatusCompleted, t0.Add(time.Second))} {
		if err := b.Append(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	got, err := b.List(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].ID != "a" || got[1].Status != StatusCompleted || got[2].ID != "b" {
		t.Fatalf("order: %+v", got)
	}
	if err := b.Append(ctx, entry("a", StatusStarted, t0)); err == nil {
		t.Fatal("the same entry was written twice")
	}
	if last, _ := b.List(ctx, 1); len(last) != 1 || last[0].ID != "b" {
		t.Fatalf("limit: %+v", last)
	}
}
