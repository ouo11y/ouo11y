package replay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

// storeFactory opens a fresh, empty store with the given video limit.
type storeFactory func(t *testing.T, maxVideo int64) Store

// testStoreContract runs the behaviour every Store must share (fs.go and
// s3.go): ordering, gzip pass-through, retried chunks replacing instead of
// duplicating, kind and project conflicts writing nothing, video limits and
// ranged reads, delete, concurrent puts.
func testStoreContract(t *testing.T, open storeFactory) {
	ctx := context.Background()

	t.Run("rrweb", func(t *testing.T) {
		st := open(t, 0)
		id := "c-rrweb-" + fmt.Sprint(time.Now().UnixNano())
		meta4 := map[string]any{"type": 4, "data": map[string]any{"href": "http://x"}, "timestamp": 1000}
		full := map[string]any{"type": 2, "data": map[string]any{"node": "..."}, "timestamp": 1001}
		inc := map[string]any{"type": 3, "data": map[string]any{"source": 1}, "timestamp": 1002}
		if st.Has(ctx, id) {
			t.Fatal("Has before put")
		}
		if _, err := st.Meta(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Meta before put: %v", err)
		}
		if _, err := st.Kind(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Kind before put: %v", err)
		}
		if _, err := st.Put(ctx, "demo", chunkJSON(id, 1, 6000, inc), nil); err != nil {
			t.Fatal(err)
		}
		plain0 := chunkJSON(id, 0, 1000, meta4, full)
		if _, err := st.Put(ctx, "demo", plain0, gz(plain0)); err != nil {
			t.Fatal(err)
		}
		m, err := st.Meta(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if m.ProjectID != "demo" || m.Kind != KindRRWeb || m.ChunkCount != 2 || m.FirstSeq != 0 || m.LastSeq != 1 ||
			m.StartedAt != 1000 || m.EndedAt != 11000 || m.Chunks[0].Bytes != int64(len(gz(plain0))) {
			t.Fatalf("meta: %+v", m)
		}
		if k, err := st.Kind(ctx, id); err != nil || k != KindRRWeb {
			t.Fatalf("kind %q %v", k, err)
		}
		rc, err := st.OpenChunk(ctx, id, 0)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(rc)
		rc.Close()
		if !bytes.Equal(got, plain0) {
			t.Fatalf("chunk 0 content: %s", got)
		}
		if _, err := st.OpenChunk(ctx, id, 7); !errors.Is(err, ErrNotFound) {
			t.Fatalf("missing chunk: %v", err)
		}
		// A retried seq replaces its entry.
		if _, err := st.Put(ctx, "demo", chunkJSON(id, 1, 6000, inc, inc), nil); err != nil {
			t.Fatal(err)
		}
		m, _ = st.Meta(ctx, id)
		if m.ChunkCount != 2 || m.Chunks[1].EventCount != 2 {
			t.Fatalf("meta after retry: %+v", m)
		}
		var out bytes.Buffer
		if err := WriteEvents(ctx, st, id, &out); err != nil {
			t.Fatal(err)
		}
		var events []map[string]any
		if err := json.Unmarshal(out.Bytes(), &events); err != nil || len(events) != 4 {
			t.Fatalf("events %v: %s", err, out.String())
		}
		// Another project or kind is refused and writes nothing.
		if _, err := st.Put(ctx, "other", chunkJSON(id, 2, 9000, inc), nil); !errors.Is(err, ErrWrongProject) {
			t.Fatalf("wrong project: %v", err)
		}
		if _, err := st.Put(ctx, "demo", mustJSON(t, framesChunk(t, id, 3, 9000, 1, nil)), nil); !errors.Is(err, ErrWrongKind) {
			t.Fatalf("wrong kind: %v", err)
		}
		for _, seq := range []int{2, 3} {
			if _, err := st.OpenChunk(ctx, id, seq); !errors.Is(err, ErrNotFound) {
				t.Fatalf("refused chunk %d was stored: %v", seq, err)
			}
		}
		if m, _ = st.Meta(ctx, id); m.ChunkCount != 2 {
			t.Fatalf("meta after refusals: %+v", m)
		}
		if err := st.Delete(ctx, id); err != nil {
			t.Fatal(err)
		}
		if st.Has(ctx, id) {
			t.Fatal("Has after delete")
		}
		if _, err := st.OpenChunk(ctx, id, 0); !errors.Is(err, ErrNotFound) {
			t.Fatalf("chunk after delete: %v", err)
		}
		if err := st.Delete(ctx, id); err != nil {
			t.Fatalf("delete of an absent replay: %v", err)
		}
	})

	t.Run("frames", func(t *testing.T) {
		st := open(t, 0)
		id := "c-frames-" + fmt.Sprint(time.Now().UnixNano())
		for seq := range 2 {
			if _, err := st.Put(ctx, "demo", mustJSON(t, framesChunk(t, id, seq, int64(1000+seq*5000), 3, nil)), nil); err != nil {
				t.Fatal(err)
			}
		}
		m, err := st.Meta(ctx, id)
		if err != nil || m.Kind != KindFrames || m.FrameCount != 6 || m.Viewport == nil || m.Platform != "ios" {
			t.Fatalf("meta %+v %v", m, err)
		}
		var out bytes.Buffer
		if err := WriteFrames(ctx, st, id, &out); err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Frames []json.RawMessage `json:"frames"`
		}
		if err := json.Unmarshal(out.Bytes(), &doc); err != nil || len(doc.Frames) != 6 {
			t.Fatalf("frames %v: %d", err, len(doc.Frames))
		}
	})

	t.Run("video", func(t *testing.T) {
		st := open(t, 4000)
		id := "c-video-" + fmt.Sprint(time.Now().UnixNano())
		mp4s := [][]byte{tinyMP4(3000, 'a'), tinyMP4(2000, 'k')}
		for seq, mp4 := range mp4s {
			c, err := st.Put(ctx, "demo", mustJSON(t, videoChunk(id, seq, int64(1000+seq*5000), mp4, nil)), nil)
			if err != nil {
				t.Fatal(err)
			}
			if c.VideoBytes != int64(len(mp4)) {
				t.Fatalf("video bytes %d", c.VideoBytes)
			}
		}
		// Above the limit: 413 material, nothing written.
		if _, err := st.Put(ctx, "demo", mustJSON(t, videoChunk(id, 2, 11000, tinyMP4(4001, 'z'), nil)), nil); !errors.Is(err, ErrTooLarge) {
			t.Fatalf("too large: %v", err)
		}
		if _, err := st.OpenVideo(ctx, id, 2); !errors.Is(err, ErrNotFound) {
			t.Fatalf("oversize segment stored: %v", err)
		}
		m, err := st.Meta(ctx, id)
		if err != nil || m.Kind != KindVideo || m.ChunkCount != 2 || m.Source == nil || m.Source.Vendor != "sentry" ||
			m.Chunks[0].VideoBytes != 3000 || m.Chunks[0].DurationMs == nil {
			t.Fatalf("meta %+v %v", m, err)
		}
		// The slim chunk JSON has no base64 mp4.
		rc, err := st.OpenChunk(ctx, id, 0)
		if err != nil {
			t.Fatal(err)
		}
		slim, _ := io.ReadAll(rc)
		rc.Close()
		if bytes.Contains(slim, []byte(`"mp4":"`)) || !bytes.Contains(slim, []byte(`"bytes":3000`)) {
			t.Fatalf("stored chunk: %s", slim)
		}
		v, err := st.OpenVideo(ctx, id, 0)
		if err != nil {
			t.Fatal(err)
		}
		if v.Size != 3000 || v.ModTime.IsZero() {
			t.Fatalf("video file: size %d mtime %v", v.Size, v.ModTime)
		}
		// Ranged read, as http.ServeContent does it for Range: bytes=1000-1099.
		if _, err := v.Content.Seek(1000, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		part := make([]byte, 100)
		if _, err := io.ReadFull(v.Content, part); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(part, mp4s[0][1000:1100]) {
			t.Fatal("ranged read returned other bytes")
		}
		if n, err := v.Content.Seek(0, io.SeekEnd); err != nil || n != 3000 {
			t.Fatalf("seek end %d %v", n, err)
		}
		v.Content.Close()
		// A retried segment replaces the mp4.
		if _, err := st.Put(ctx, "demo", mustJSON(t, videoChunk(id, 1, 6000, tinyMP4(2500, 'q'), nil)), nil); err != nil {
			t.Fatal(err)
		}
		v, err = st.OpenVideo(ctx, id, 1)
		if err != nil {
			t.Fatal(err)
		}
		all, _ := io.ReadAll(v.Content)
		v.Content.Close()
		if !bytes.Equal(all, tinyMP4(2500, 'q')) || v.Size != 2500 {
			t.Fatalf("replaced segment: %d bytes", len(all))
		}
		man, err := BuildVideoManifest(ctx, st, id)
		if err != nil || len(man.Segments) != 2 {
			t.Fatalf("manifest %+v %v", man, err)
		}
		if err := st.Delete(ctx, id); err != nil {
			t.Fatal(err)
		}
		if _, err := st.OpenVideo(ctx, id, 0); !errors.Is(err, ErrNotFound) {
			t.Fatalf("video after delete: %v", err)
		}
	})

	t.Run("concurrent", func(t *testing.T) {
		st := open(t, 0)
		id := "c-conc-" + fmt.Sprint(time.Now().UnixNano())
		var wg sync.WaitGroup
		for i := range 20 {
			wg.Go(func() {
				if _, err := st.Put(ctx, "demo", chunkJSON(id, i, int64(i*1000), map[string]any{"type": 3, "n": i}), nil); err != nil {
					t.Error(err)
				}
			})
		}
		wg.Wait()
		m, err := st.Meta(ctx, id)
		if err != nil || m.ChunkCount != 20 || m.FirstSeq != 0 || m.LastSeq != 19 {
			t.Fatalf("meta %+v %v", m, err)
		}
	})

	t.Run("validation", func(t *testing.T) {
		st := open(t, 0)
		for _, b := range [][]byte{[]byte(`[]`), []byte(`{"session_id":"../etc","seq":0,"events":[]}`), []byte(`{"session_id":"ok","seq":-1,"events":[]}`)} {
			if _, err := st.Put(ctx, "demo", b, nil); !errors.Is(err, ErrInvalid) {
				t.Errorf("%s: %v", b, err)
			}
		}
		if st.Has(ctx, "../etc") || st.Has(ctx, "") {
			t.Error("Has must reject unsafe ids")
		}
	})
}

func TestFSContract(t *testing.T) {
	testStoreContract(t, func(t *testing.T, maxVideo int64) Store {
		st, err := NewFS(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		st.MaxVideoBytes = maxVideo
		return st
	})
}
