package replay

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func chunkJSON(id string, seq int, start int64, events ...any) []byte {
	b, _ := json.Marshal(map[string]any{"session_id": id, "seq": seq, "started_at": start, "ended_at": start + 5000, "events": events})
	return b
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	w.Write(b)
	w.Close()
	return buf.Bytes()
}

func TestPutMetaEvents(t *testing.T) {
	ctx := context.Background()
	st, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.Now = func() time.Time { return time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC) }
	id := "2f1c3d44-aaaa-4bbb-8ccc-0123456789ab"
	meta4 := map[string]any{"type": 4, "data": map[string]any{"href": "http://x"}, "timestamp": 1000}
	full := map[string]any{"type": 2, "data": map[string]any{"node": "..."}, "timestamp": 1001}
	inc := map[string]any{"type": 3, "data": map[string]any{"source": 1}, "timestamp": 1002}

	// seq 1 arrives first (out of order), plain body.
	if _, err := st.Put(ctx, chunkJSON(id, 1, 6000, inc), nil); err != nil {
		t.Fatal(err)
	}
	// seq 0 arrives gzip.
	plain0 := chunkJSON(id, 0, 1000, meta4, full)
	c, err := st.Put(ctx, plain0, gz(plain0))
	if err != nil {
		t.Fatal(err)
	}
	if c.Seq != 0 || c.EventCount != 2 || c.SessionID != id {
		t.Fatalf("chunk: %+v", c)
	}
	if !st.Has(ctx, id) {
		t.Fatal("Has false")
	}
	m, err := st.Meta(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if m.ChunkCount != 2 || m.FirstSeq != 0 || m.LastSeq != 1 || m.StartedAt != 1000 || m.EndedAt != 11000 || m.Bytes <= 0 {
		t.Fatalf("meta: %+v", m)
	}
	if len(m.Chunks) != 2 || m.Chunks[0].Seq != 0 || m.Chunks[1].Seq != 1 || m.Chunks[0].EventCount != 2 {
		t.Fatalf("meta chunks: %+v", m.Chunks)
	}
	for _, name := range []string{"000000.json.gz", "000001.json.gz", "meta.json"} {
		if _, err := os.Stat(filepath.Join(st.Root, id, name)); err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
	}
	// Stored file is the original gzip bytes.
	raw, _ := os.ReadFile(filepath.Join(st.Root, id, "000000.json.gz"))
	if !bytes.Equal(raw, gz(plain0)) {
		t.Fatal("gzip body was not stored as-is")
	}
	// Re-post of seq 1 replaces instead of duplicating.
	if _, err := st.Put(ctx, chunkJSON(id, 1, 6000, inc, inc), nil); err != nil {
		t.Fatal(err)
	}
	m, _ = st.Meta(ctx, id)
	if m.ChunkCount != 2 || m.Chunks[1].EventCount != 2 {
		t.Fatalf("meta after replace: %+v", m)
	}

	var out bytes.Buffer
	if err := WriteEvents(ctx, st, id, &out); err != nil {
		t.Fatal(err)
	}
	var events []map[string]any
	if err := json.Unmarshal(out.Bytes(), &events); err != nil {
		t.Fatalf("events not a JSON array: %v: %s", err, out.String())
	}
	if len(events) != 4 || events[0]["type"].(float64) != 4 || events[1]["type"].(float64) != 2 || events[2]["type"].(float64) != 3 {
		t.Fatalf("events: %v", events)
	}

	if err := st.Delete(ctx, id); err != nil {
		t.Fatal(err)
	}
	if st.Has(ctx, id) {
		t.Fatal("still has replay after delete")
	}
	if _, err := st.Meta(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := WriteEvents(ctx, st, id, &out); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestPutValidation(t *testing.T) {
	st, _ := NewFS(t.TempDir())
	ctx := context.Background()
	bad := [][]byte{
		[]byte(`[]`),
		[]byte(`{"session_id":"../etc","seq":0,"events":[]}`),
		[]byte(`{"session_id":"a b","seq":0,"events":[]}`),
		[]byte(`{"session_id":"ok","seq":-1,"events":[]}`),
		[]byte(`{"session_id":"ok","seq":0}`),
		[]byte(`{"session_id":"ok","seq":0,"events":{}}`),
		[]byte(`{"session_id":"` + string(bytes.Repeat([]byte("a"), 65)) + `","seq":0,"events":[]}`),
		[]byte(`{"session_id":"ok","seq":0,"events":[`),
	}
	for _, b := range bad {
		if _, err := st.Put(ctx, b, nil); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: expected ErrInvalid, got %v", b, err)
		}
	}
	if _, err := st.Put(ctx, []byte(`{"session_id":"ok-1","seq":0,"events":[],"extra":{"x":1}}`), nil); err != nil {
		t.Errorf("unknown keys must be tolerated: %v", err)
	}
	if st.Has(ctx, "../etc") || st.Has(ctx, "") {
		t.Error("Has must reject unsafe ids")
	}
	if _, err := st.OpenChunk(ctx, "ok-1", 7); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing chunk: %v", err)
	}
}

func TestConcurrentPuts(t *testing.T) {
	st, _ := NewFS(t.TempDir())
	ctx := context.Background()
	id := "concurrent-session"
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(seq int) {
			defer wg.Done()
			if _, err := st.Put(ctx, chunkJSON(id, seq, int64(seq*1000), map[string]any{"type": 3, "n": seq}), nil); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	m, err := st.Meta(ctx, id)
	if err != nil || m.ChunkCount != 20 || m.FirstSeq != 0 || m.LastSeq != 19 {
		t.Fatalf("meta: %+v %v", m, err)
	}
	for i, ch := range m.Chunks {
		if ch.Seq != i {
			t.Fatalf("chunk order: %+v", m.Chunks)
		}
	}
	var out bytes.Buffer
	if err := WriteEvents(ctx, st, id, &out); err != nil {
		t.Fatal(err)
	}
	var events []map[string]any
	json.Unmarshal(out.Bytes(), &events)
	for i, ev := range events {
		if int(ev["n"].(float64)) != i {
			t.Fatalf("events out of seq order at %d: %v", i, ev)
		}
	}
	// no temp files left behind
	entries, _ := os.ReadDir(filepath.Join(st.Root, id))
	for _, e := range entries {
		if len(e.Name()) > 4 && e.Name()[:4] == ".tmp" {
			t.Fatalf("temp file left: %s", e.Name())
		}
	}
	if len(entries) != 21 {
		t.Fatalf("expected 20 chunks + meta, got %d", len(entries))
	}
	_ = fmt.Sprint
}
