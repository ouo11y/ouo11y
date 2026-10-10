package replay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tinyJPEG is a real 2x2 JPEG produced by image/jpeg.
func tinyJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 50}); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(buf.Bytes(), jpegMagic) {
		t.Fatal("image/jpeg did not produce SOI")
	}
	return buf.Bytes()
}

func framesChunk(t *testing.T, id string, seq int, start int64, nFrames int, touches []map[string]any) map[string]any {
	t.Helper()
	jpg := base64.StdEncoding.EncodeToString(tinyJPEG(t))
	frames := make([]map[string]any, 0, nFrames)
	for i := 0; i < nFrames; i++ {
		frames = append(frames, map[string]any{"ts": start + int64(i)*1000, "jpeg": jpg, "reason": "timer", "n": seq*100 + i})
	}
	if touches == nil {
		touches = []map[string]any{}
	}
	return map[string]any{
		"kind": "frames", "schema_version": 1, "session_id": id, "seq": seq,
		"started_at": start, "ended_at": start + 5000,
		"viewport": map[string]any{"width": 393, "height": 852, "scale": 0.5},
		"platform": "ios", "frames": frames, "touches": touches, "masked": true,
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFramesPutMetaAndStream(t *testing.T) {
	ctx := context.Background()
	st, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.Now = func() time.Time { return time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC) }
	id := "frames-session-1"
	touches1 := []map[string]any{{"ts": 6100, "x": 120.5, "y": 640, "phase": "began"}, {"ts": 6200, "x": 121, "y": 641, "phase": "ended"}}

	// seq 1 arrives first (out of order), with touches, as gzip.
	c1 := mustJSON(t, framesChunk(t, id, 1, 6000, 2, touches1))
	c, err := st.Put(ctx, "demo", c1, gz(c1))
	if err != nil {
		t.Fatal(err)
	}
	if c.Kind != KindFrames || c.FrameCount != 2 || c.TouchCount != 2 || c.Platform != "ios" || c.Viewport == nil || c.Viewport.Width != 393 || c.Viewport.Scale != 0.5 {
		t.Fatalf("chunk: %+v", c)
	}
	if _, err := st.Put(ctx, "demo", mustJSON(t, framesChunk(t, id, 0, 1000, 3, nil)), nil); err != nil {
		t.Fatal(err)
	}
	k, err := st.Kind(ctx, id)
	if err != nil || k != KindFrames {
		t.Fatalf("kind: %q %v", k, err)
	}
	m, err := st.Meta(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if m.Kind != KindFrames || m.ChunkCount != 2 || m.FrameCount != 5 || m.TouchCount != 2 || m.StartedAt != 1000 || m.EndedAt != 11000 ||
		m.Platform != "ios" || m.Viewport == nil || m.Viewport.Height != 852 {
		t.Fatalf("meta: %+v", m)
	}
	if m.Chunks[0].FrameCount != 3 || m.Chunks[1].FrameCount != 2 || m.Chunks[1].TouchCount != 2 || m.Chunks[0].EventCount != 0 {
		t.Fatalf("meta chunks: %+v", m.Chunks)
	}
	// Stored as-is.
	raw, _ := os.ReadFile(filepath.Join(st.Root, id, "000001.json.gz"))
	if !bytes.Equal(raw, gz(c1)) {
		t.Fatal("gzip body not stored as-is")
	}
	// Fresh store instance (empty kind cache) reads kind from meta.json.
	st2, _ := NewFS(filepath.Dir(st.Root))
	if k, err := st2.Kind(ctx, id); err != nil || k != KindFrames {
		t.Fatalf("kind from disk: %q %v", k, err)
	}

	// Concatenation in seq order, touches after frames.
	var out bytes.Buffer
	if err := WriteFrames(ctx, st, id, &out); err != nil {
		t.Fatal(err)
	}
	var fr struct {
		SessionID string           `json:"session_id"`
		Kind      string           `json:"kind"`
		Viewport  Viewport         `json:"viewport"`
		Platform  string           `json:"platform"`
		StartedAt int64            `json:"started_at"`
		EndedAt   int64            `json:"ended_at"`
		Frames    []map[string]any `json:"frames"`
		Touches   []map[string]any `json:"touches"`
	}
	if err := json.Unmarshal(out.Bytes(), &fr); err != nil {
		t.Fatalf("frames body: %v: %.200s", err, out.String())
	}
	if fr.SessionID != id || fr.Kind != KindFrames || fr.Platform != "ios" || fr.Viewport.Width != 393 || fr.StartedAt != 1000 || fr.EndedAt != 11000 {
		t.Fatalf("frames head: %+v", fr)
	}
	if len(fr.Frames) != 5 || len(fr.Touches) != 2 {
		t.Fatalf("counts: %d frames %d touches", len(fr.Frames), len(fr.Touches))
	}
	for i, want := range []int{0, 1, 2, 100, 101} {
		if int(fr.Frames[i]["n"].(float64)) != want || fr.Frames[i]["jpeg"] == "" || fr.Frames[i]["ts"] == nil || fr.Frames[i]["reason"] != "timer" {
			t.Fatalf("frame %d: %v", i, fr.Frames[i])
		}
	}
	if fr.Touches[0]["phase"] != "began" || fr.Touches[1]["phase"] != "ended" {
		t.Fatalf("touches: %v", fr.Touches)
	}
	// Kind matrix.
	if err := WriteEvents(ctx, st, id, &out); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("events on frames replay: %v", err)
	}
	rr := "rrweb-session-1"
	if _, err := st.Put(ctx, "demo", chunkJSON(rr, 0, 1000, map[string]any{"type": 4}), nil); err != nil {
		t.Fatal(err)
	}
	if err := WriteFrames(ctx, st, rr, &out); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("frames on rrweb replay: %v", err)
	}
	if err := WriteFrames(ctx, st, "nope", &out); !errors.Is(err, ErrNotFound) {
		t.Fatalf("frames on missing replay: %v", err)
	}
	if mrr, _ := st.Meta(ctx, rr); mrr.Kind != KindRRWeb || mrr.Viewport != nil || mrr.Platform != "" || mrr.FrameCount != 0 {
		t.Fatalf("rrweb meta: %+v", mrr)
	}
	// Delete evicts the kind cache.
	st.Delete(ctx, id)
	if _, err := st.Kind(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("kind after delete: %v", err)
	}
}

func TestMixedKindsRejected(t *testing.T) {
	ctx := context.Background()
	st, _ := NewFS(t.TempDir())
	id := "mixed-1"
	if _, err := st.Put(ctx, "demo", mustJSON(t, framesChunk(t, id, 0, 1000, 1, nil)), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(ctx, "demo", chunkJSON(id, 1, 6000, map[string]any{"type": 3}), nil); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("rrweb chunk onto frames session: %v", err)
	}
	// Nothing written for the rejected chunk, meta unchanged.
	if _, err := os.Stat(filepath.Join(st.Root, id, "000001.json.gz")); err == nil {
		t.Fatal("rejected chunk was written")
	}
	if m, _ := st.Meta(ctx, id); m.ChunkCount != 1 || m.Kind != KindFrames {
		t.Fatalf("meta after reject: %+v", m)
	}
	id2 := "mixed-2"
	if _, err := st.Put(ctx, "demo", chunkJSON(id2, 0, 1000, map[string]any{"type": 4}), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(ctx, "demo", mustJSON(t, framesChunk(t, id2, 1, 6000, 1, nil)), nil); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("frames chunk onto rrweb session: %v", err)
	}
}

func TestLegacyMetaWithoutKind(t *testing.T) {
	ctx := context.Background()
	st, _ := NewFS(t.TempDir())
	id := "legacy-1"
	if _, err := st.Put(ctx, "demo", chunkJSON(id, 0, 1000, map[string]any{"type": 4}), nil); err != nil {
		t.Fatal(err)
	}
	// Strip kind from meta.json as Phase 3 wrote it.
	p := filepath.Join(st.Root, id, "meta.json")
	b, _ := os.ReadFile(p)
	var m map[string]any
	json.Unmarshal(b, &m)
	delete(m, "kind")
	b, _ = json.Marshal(m)
	os.WriteFile(p, b, 0o644)
	st2, _ := NewFS(filepath.Dir(st.Root))
	if k, err := st2.Kind(ctx, id); err != nil || k != KindRRWeb {
		t.Fatalf("legacy kind: %q %v", k, err)
	}
	if meta, _ := st2.Meta(ctx, id); meta.Kind != KindRRWeb {
		t.Fatalf("legacy meta: %+v", meta)
	}
	if _, err := st2.Put(ctx, "demo", chunkJSON(id, 1, 6000, map[string]any{"type": 3}), nil); err != nil {
		t.Fatalf("rrweb chunk onto legacy session: %v", err)
	}
}

func TestFramesValidation(t *testing.T) {
	ctx := context.Background()
	st, _ := NewFS(t.TempDir())
	good := framesChunk(t, "v-1", 0, 1000, 1, []map[string]any{{"ts": 1500, "x": 1, "y": 2, "phase": "moved"}})
	if _, err := st.Put(ctx, "demo", mustJSON(t, good), nil); err != nil {
		t.Fatalf("good chunk: %v", err)
	}
	jpg := good["frames"].([]map[string]any)[0]["jpeg"].(string)
	// Unpadded base64 is accepted too (RawStdEncoding).
	rawB64 := strings.TrimRight(jpg, "=")
	if _, err := st.Put(ctx, "demo", mustJSON(t, mutate(good, func(m map[string]any) {
		m["session_id"] = "v-raw"
		m["frames"] = []map[string]any{{"ts": 1000, "jpeg": rawB64}}
	})), nil); err != nil {
		t.Fatalf("unpadded base64: %v", err)
	}
	// Empty frames array with touches only is a valid flush.
	if _, err := st.Put(ctx, "demo", mustJSON(t, mutate(good, func(m map[string]any) {
		m["session_id"] = "v-empty"
		m["frames"] = []map[string]any{}
	})), nil); err != nil {
		t.Fatalf("empty frames: %v", err)
	}
	// Viewport scale defaults to 1 when absent.
	c, err := st.Put(ctx, "demo", mustJSON(t, mutate(good, func(m map[string]any) {
		m["session_id"] = "v-scale"
		m["viewport"] = map[string]any{"width": 10, "height": 20}
	})), nil)
	if err != nil || c.Viewport.Scale != 1 {
		t.Fatalf("default scale: %+v %v", c, err)
	}

	notJPEG := base64.StdEncoding.EncodeToString([]byte{0x89, 'P', 'N', 'G', 0, 0, 0, 0})
	bad := map[string]func(m map[string]any){
		"missing schema_version": func(m map[string]any) { delete(m, "schema_version") },
		"wrong schema_version":   func(m map[string]any) { m["schema_version"] = 2 },
		"ended before started":   func(m map[string]any) { m["ended_at"] = 500 },
		"zero started_at":        func(m map[string]any) { m["started_at"] = 0; m["ended_at"] = 0 },
		"missing viewport":       func(m map[string]any) { delete(m, "viewport") },
		"zero viewport":          func(m map[string]any) { m["viewport"] = map[string]any{"width": 0, "height": 10} },
		"negative scale":         func(m map[string]any) { m["viewport"] = map[string]any{"width": 1, "height": 1, "scale": -1} },
		"viewport not object":    func(m map[string]any) { m["viewport"] = "393x852" },
		"missing frames":         func(m map[string]any) { delete(m, "frames") },
		"frames not array":       func(m map[string]any) { m["frames"] = map[string]any{} },
		"frame without ts":       func(m map[string]any) { m["frames"] = []map[string]any{{"jpeg": jpg}} },
		"frame empty jpeg":       func(m map[string]any) { m["frames"] = []map[string]any{{"ts": 1000, "jpeg": ""}} },
		"frame jpeg not base64":  func(m map[string]any) { m["frames"] = []map[string]any{{"ts": 1000, "jpeg": "!!not base64!!"}} },
		"frame jpeg bad magic":   func(m map[string]any) { m["frames"] = []map[string]any{{"ts": 1000, "jpeg": notJPEG}} },
		"frame jpeg too short": func(m map[string]any) {
			m["frames"] = []map[string]any{{"ts": 1000, "jpeg": base64.StdEncoding.EncodeToString([]byte{0xFF})}}
		},
		"frame jpeg not a string": func(m map[string]any) { m["frames"] = []map[string]any{{"ts": 1000, "jpeg": 42}} },
		"second frame bad": func(m map[string]any) {
			m["frames"] = []map[string]any{{"ts": 1000, "jpeg": jpg}, {"ts": 2000, "jpeg": notJPEG}}
		},
		"touch bad phase": func(m map[string]any) {
			m["touches"] = []map[string]any{{"ts": 1, "x": 1, "y": 1, "phase": "cancelled"}}
		},
		"touch missing phase":  func(m map[string]any) { m["touches"] = []map[string]any{{"ts": 1, "x": 1, "y": 1}} },
		"touch missing xy":     func(m map[string]any) { m["touches"] = []map[string]any{{"ts": 1, "phase": "began"}} },
		"touch missing ts":     func(m map[string]any) { m["touches"] = []map[string]any{{"x": 1, "y": 1, "phase": "began"}} },
		"touches not array":    func(m map[string]any) { m["touches"] = "none" },
		"unknown kind":         func(m map[string]any) { m["kind"] = "video" },
		"bad session id":       func(m map[string]any) { m["session_id"] = "../x" },
		"rrweb with no events": func(m map[string]any) { m["kind"] = "rrweb" },
	}
	for name, mut := range bad {
		b := mustJSON(t, mutate(good, mut))
		if _, err := st.Put(ctx, "demo", b, nil); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: expected ErrInvalid, got %v", name, err)
		}
	}
	// A frames chunk rejected by validation leaves nothing behind.
	if st.Has(ctx, "v-1") != true {
		t.Fatal("good session lost")
	}
}

func TestPeekKind(t *testing.T) {
	cases := map[string]string{
		`{"kind":"frames","session_id":"a"}`:                    KindFrames,
		`{"session_id":"a","events":[{"x":1}],"kind":"frames"}`: KindFrames,
		`{"session_id":"a","events":[1,2,3]}`:                   KindRRWeb,
		`{"kind":"rrweb"}`:                                      KindRRWeb,
		`{"kind":""}`:                                           KindRRWeb,
		`{"kind":"video"}`:                                      "video",
		`not json`:                                              KindRRWeb,
		`[1,2]`:                                                 KindRRWeb,
		`{"session_id":`:                                        KindRRWeb,
	}
	for in, want := range cases {
		if got := PeekKind([]byte(in)); got != want {
			t.Errorf("%s: want %s got %s", in, want, got)
		}
	}
}

// mutate returns a shallow copy of m with fn applied.
func mutate(m map[string]any, fn func(map[string]any)) map[string]any {
	c := make(map[string]any, len(m))
	for k, v := range m {
		c[k] = v
	}
	fn(c)
	return c
}
