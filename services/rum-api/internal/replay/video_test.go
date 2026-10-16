package replay

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tinyMP4 returns n bytes that look like an mp4 to the validator: a 24-byte
// ftyp box (size 0x18, major brand mp42) followed by filler. tag makes the
// payload of different segments distinguishable.
func tinyMP4(n int, tag byte) []byte {
	b := []byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
	for i := 0; len(b) < n; i++ {
		b = append(b, tag+byte(i%7))
	}
	return b[:max(n, 8)]
}

func videoChunk(id string, seq int, start int64, mp4 []byte, touches []map[string]any) map[string]any {
	if touches == nil {
		touches = []map[string]any{}
	}
	return map[string]any{
		"kind": "video", "schema_version": 1, "session_id": id, "seq": seq,
		"started_at": start, "ended_at": start + 5000,
		"viewport": map[string]any{"width": 288, "height": 624, "scale": 1},
		"platform": "ios",
		"video": map[string]any{
			"container": "mp4", "encoding": "h264", "duration_ms": 5000, "frame_count": 5, "frame_rate": 1,
			"mp4": base64.StdEncoding.EncodeToString(mp4),
		},
		"touches": touches,
		"source":  map[string]any{"vendor": "sentry", "replay_id": "0123456789abcdef0123456789abcdef", "segment_id": seq, "replay_type": "session"},
		"masked":  true,
	}
}

func readGz(t *testing.T, path string) []byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(gr)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestVideoPutMetaManifest(t *testing.T) {
	ctx := context.Background()
	st, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.Now = func() time.Time { return time.Date(2026, 10, 14, 10, 0, 0, 0, time.UTC) }
	id := "video-session-1"
	mp4a, mp4b := tinyMP4(300, 'a'), tinyMP4(500, 'b')
	touches1 := []map[string]any{{"ts": 6100, "x": 120.5, "y": 410, "phase": "began"}, {"ts": 6200, "x": 121, "y": 411, "phase": "ended"}}

	// seq 1 first, uploaded as gzip (the gzip must not be stored as-is).
	b1 := mustJSON(t, videoChunk(id, 1, 6000, mp4b, touches1))
	c, err := st.Put(ctx, "mobile-store", b1, gz(b1))
	if err != nil {
		t.Fatal(err)
	}
	if c.Kind != KindVideo || c.FrameCount != 5 || c.TouchCount != 2 || c.DurationMs != 5000 || c.VideoBytes != 500 ||
		c.Platform != "ios" || c.Viewport == nil || c.Viewport.Width != 288 || c.Source == nil || c.Source.Vendor != "sentry" {
		t.Fatalf("chunk: %+v", c)
	}
	if _, err := st.Put(ctx, "mobile-store", mustJSON(t, videoChunk(id, 0, 1000, mp4a, nil)), nil); err != nil {
		t.Fatal(err)
	}

	// Files: mp4 byte-identical, json.gz without video.mp4 but with video.bytes.
	dir := filepath.Join(st.Root, id)
	if got, _ := os.ReadFile(filepath.Join(dir, "000001.mp4")); !bytes.Equal(got, mp4b) {
		t.Fatalf("stored mp4 differs: %d bytes", len(got))
	}
	stored := readGz(t, filepath.Join(dir, "000001.json.gz"))
	var sc map[string]any
	if err := json.Unmarshal(stored, &sc); err != nil {
		t.Fatalf("stored json: %v %s", err, stored)
	}
	video := sc["video"].(map[string]any)
	if _, ok := video["mp4"]; ok || video["bytes"] != float64(500) || video["encoding"] != "h264" || video["frame_rate"] != float64(1) {
		t.Fatalf("stored video: %v", video)
	}
	if sc["masked"] != true || sc["source"].(map[string]any)["replay_type"] != "session" || len(sc["touches"].([]any)) != 2 {
		t.Fatalf("stored chunk lost fields: %s", stored)
	}

	m, err := st.Meta(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if m.Kind != KindVideo || m.ProjectID != "mobile-store" || m.ChunkCount != 2 || m.FrameCount != 10 || m.TouchCount != 2 ||
		m.StartedAt != 1000 || m.EndedAt != 11000 || m.Platform != "ios" || m.Viewport == nil || m.Viewport.Height != 624 ||
		m.Source == nil || m.Source.ReplayID != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("meta: %+v", m)
	}
	if m.Chunks[0].Seq != 0 || m.Chunks[0].DurationMs == nil || *m.Chunks[0].DurationMs != 5000 || m.Chunks[0].VideoBytes != 300 || m.Chunks[0].Bytes <= 300 {
		t.Fatalf("chunk 0 info: %+v", m.Chunks[0])
	}
	if k, _ := st.Kind(ctx, id); k != KindVideo {
		t.Fatalf("kind %q", k)
	}

	// OpenVideo.
	v, err := st.OpenVideo(ctx, id, 0)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(v.Content)
	v.Content.Close()
	if !bytes.Equal(got, mp4a) || v.Size != 300 || v.ModTime.IsZero() {
		t.Fatalf("open video: %d bytes size %d", len(got), v.Size)
	}
	if _, err := st.OpenVideo(ctx, id, 7); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing segment: %v", err)
	}

	// Manifest.
	man, err := BuildVideoManifest(ctx, st, id)
	if err != nil {
		t.Fatal(err)
	}
	if man.SessionID != id || man.Kind != KindVideo || man.StartedAt != 1000 || man.EndedAt != 11000 || man.Platform != "ios" ||
		len(man.Segments) != 2 || len(man.Touches) != 2 || man.Source == nil || man.Source.Vendor != "sentry" {
		t.Fatalf("manifest: %+v", man)
	}
	want := []VideoSegment{
		{Seq: 0, StartedAt: 1000, EndedAt: 6000, DurationMs: 5000, FrameCount: 5, Bytes: 300, Path: "/v1/sessions/" + id + "/replay/video/0"},
		{Seq: 1, StartedAt: 6000, EndedAt: 11000, DurationMs: 5000, FrameCount: 5, Bytes: 500, Path: "/v1/sessions/" + id + "/replay/video/1"},
	}
	for i := range want {
		if man.Segments[i] != want[i] {
			t.Fatalf("segment %d: %+v want %+v", i, man.Segments[i], want[i])
		}
	}
	var buf bytes.Buffer
	if err := WriteVideo(ctx, st, id, &buf); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(buf.String(), `{"session_id":"`+id+`","kind":"video","viewport":{"width":288,"height":624,"scale":1},"platform":"ios"`) {
		t.Fatalf("manifest json: %.200s", buf.String())
	}
	// The other kinds' readers refuse a video replay, and vice versa.
	if err := WriteEvents(ctx, st, id, io.Discard); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("events on video: %v", err)
	}
	if err := WriteFrames(ctx, st, id, io.Discard); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("frames on video: %v", err)
	}

	// Re-posting a seq replaces both files and the meta entry.
	mp4c := tinyMP4(120, 'c')
	repost := videoChunk(id, 1, 6000, mp4c, nil)
	repost["video"].(map[string]any)["frame_count"] = 2
	if _, err := st.Put(ctx, "mobile-store", mustJSON(t, repost), nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "000001.mp4")); !bytes.Equal(got, mp4c) {
		t.Fatal("mp4 not replaced")
	}
	m, _ = st.Meta(ctx, id)
	if m.ChunkCount != 2 || m.FrameCount != 7 || m.TouchCount != 0 || m.Chunks[1].VideoBytes != 120 {
		t.Fatalf("meta after replace: %+v", m)
	}
	if man, _ := BuildVideoManifest(ctx, st, id); len(man.Touches) != 0 || man.Segments[1].Bytes != 120 {
		t.Fatalf("manifest after replace: %+v", man)
	}

	// Kinds never mix, in both directions; nothing is written.
	if _, err := st.Put(ctx, "mobile-store", mustJSON(t, framesChunk(t, id, 2, 11000, 1, nil)), nil); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("frames onto video: %v", err)
	}
	if _, err := st.Put(ctx, "mobile-store", chunkJSON(id, 2, 11000, map[string]any{"type": 3}), nil); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("rrweb onto video: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "000002.json.gz")); err == nil {
		t.Fatal("rejected chunk written")
	}
	fid := "frames-then-video"
	if _, err := st.Put(ctx, "demo", mustJSON(t, framesChunk(t, fid, 0, 1000, 1, nil)), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(ctx, "demo", mustJSON(t, videoChunk(fid, 1, 6000, mp4a, nil)), nil); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("video onto frames: %v", err)
	}
	if _, err := os.Stat(filepath.Join(st.Root, fid, "000001.mp4")); err == nil {
		t.Fatal("rejected video written")
	}
	if _, err := BuildVideoManifest(ctx, st, fid); !errors.Is(err, ErrWrongKind) {
		t.Fatalf("manifest on frames: %v", err)
	}
	// Another project: 403 path, nothing written.
	if _, err := st.Put(ctx, "other", mustJSON(t, videoChunk(id, 5, 30000, mp4a, nil)), nil); !errors.Is(err, ErrWrongProject) {
		t.Fatalf("other project: %v", err)
	}

	// Delete removes the directory, mp4 included.
	if err := st.Delete(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("dir after delete: %v", err)
	}
	if _, err := st.OpenVideo(ctx, id, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("open after delete: %v", err)
	}
}

func TestVideoValidation(t *testing.T) {
	ctx := context.Background()
	st, _ := NewFS(t.TempDir())
	st.MaxVideoBytes = 1000
	mp4 := tinyMP4(200, 'a')
	good := videoChunk("v-1", 0, 1000, mp4, []map[string]any{{"ts": 1500, "x": 1, "y": 2, "phase": "moved"}})
	if _, err := st.Put(ctx, "demo", mustJSON(t, good), nil); err != nil {
		t.Fatalf("good chunk: %v", err)
	}
	withVideo := func(fn func(v map[string]any)) func(m map[string]any) {
		return func(m map[string]any) {
			v := map[string]any{}
			for k, x := range m["video"].(map[string]any) {
				v[k] = x
			}
			fn(v)
			m["video"] = v
		}
	}
	ok := map[string]func(m map[string]any){
		"unpadded base64": withVideo(func(v map[string]any) {
			v["mp4"] = base64.RawStdEncoding.EncodeToString(tinyMP4(202, 'a')) // 202 % 3 != 0: padding stripped
		}),
		"exactly the limit": withVideo(func(v map[string]any) { v["mp4"] = base64.StdEncoding.EncodeToString(tinyMP4(1000, 'a')) }),
		"no source":         func(m map[string]any) { delete(m, "source") },
		"null source":       func(m map[string]any) { m["source"] = nil },
		"no touches":        func(m map[string]any) { delete(m, "touches") },
		"no platform":       func(m map[string]any) { delete(m, "platform") },
		"minimal video": func(m map[string]any) {
			m["video"] = map[string]any{"container": "mp4", "mp4": m["video"].(map[string]any)["mp4"]}
		},
		"zero length window": func(m map[string]any) { m["ended_at"] = m["started_at"] },
	}
	for name, mut := range ok {
		b := mustJSON(t, mutate(mutate(good, mut), func(m map[string]any) { m["session_id"] = "ok-" + strings.ReplaceAll(name, " ", "-") }))
		if _, err := st.Put(ctx, "demo", b, nil); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Without duration_ms the chunk duration is ended_at - started_at.
	c, err := st.Put(ctx, "demo", mustJSON(t, mutate(good, func(m map[string]any) {
		m["session_id"] = "v-nodur"
		m["ended_at"] = 1000 + 4200
		withVideo(func(v map[string]any) { delete(v, "duration_ms"); delete(v, "frame_count") })(m)
	})), nil)
	if err != nil || c.DurationMs != 4200 || c.FrameCount != 0 {
		t.Fatalf("derived duration: %+v %v", c, err)
	}

	badFtyp := append([]byte("\x00\x00\x00\x18moov"), make([]byte, 40)...)
	bad := map[string]func(m map[string]any){
		"missing schema_version": func(m map[string]any) { delete(m, "schema_version") },
		"wrong schema_version":   func(m map[string]any) { m["schema_version"] = 2 },
		"zero started_at":        func(m map[string]any) { m["started_at"] = 0; m["ended_at"] = 0 },
		"ended before started":   func(m map[string]any) { m["ended_at"] = 500 },
		"missing viewport":       func(m map[string]any) { delete(m, "viewport") },
		"zero viewport":          func(m map[string]any) { m["viewport"] = map[string]any{"width": 288, "height": 0} },
		"missing video":          func(m map[string]any) { delete(m, "video") },
		"video not object":       func(m map[string]any) { m["video"] = "mp4" },
		"video null":             func(m map[string]any) { m["video"] = nil },
		"wrong container":        withVideo(func(v map[string]any) { v["container"] = "webm" }),
		"missing container":      withVideo(func(v map[string]any) { delete(v, "container") }),
		"missing mp4":            withVideo(func(v map[string]any) { delete(v, "mp4") }),
		"empty mp4":              withVideo(func(v map[string]any) { v["mp4"] = "" }),
		"mp4 not string":         withVideo(func(v map[string]any) { v["mp4"] = 42 }),
		"bad base64":             withVideo(func(v map[string]any) { v["mp4"] = "!!not base64!!" }),
		"bad ftyp":               withVideo(func(v map[string]any) { v["mp4"] = base64.StdEncoding.EncodeToString(badFtyp) }),
		"mp4 too short":          withVideo(func(v map[string]any) { v["mp4"] = base64.StdEncoding.EncodeToString([]byte("\x00\x00ft")) }),
		"negative frame_count":   withVideo(func(v map[string]any) { v["frame_count"] = -1 }),
		"negative duration":      withVideo(func(v map[string]any) { v["duration_ms"] = -5 }),
		"frame_count not int":    withVideo(func(v map[string]any) { v["frame_count"] = "5" }),
		"encoding not string":    withVideo(func(v map[string]any) { v["encoding"] = 264 }),
		"touch bad phase": func(m map[string]any) {
			m["touches"] = []map[string]any{{"ts": 1, "x": 1, "y": 1, "phase": "cancelled"}}
		},
		"touch missing xy":     func(m map[string]any) { m["touches"] = []map[string]any{{"ts": 1, "phase": "began"}} },
		"source not object":    func(m map[string]any) { m["source"] = "sentry" },
		"source replay_id int": func(m map[string]any) { m["source"] = map[string]any{"vendor": "sentry", "replay_id": 7} },
	}
	for name, mut := range bad {
		b := mustJSON(t, mutate(mutate(good, mut), func(m map[string]any) { m["session_id"] = "bad-1" }))
		if _, err := st.Put(ctx, "demo", b, nil); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: expected ErrInvalid, got %v", name, err)
		}
	}
	// Too big: one byte above the limit, padded and unpadded.
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding} {
		b := mustJSON(t, mutate(good, withVideo(func(v map[string]any) { v["mp4"] = enc.EncodeToString(tinyMP4(1001, 'a')) })))
		if _, err := st.Put(ctx, "demo", b, nil); !errors.Is(err, ErrTooLarge) {
			t.Errorf("too big: expected ErrTooLarge, got %v", err)
		}
	}
	if st.Has(ctx, "bad-1") {
		t.Fatal("rejected chunks left a replay behind")
	}
}

// TestSpliceVideoKeepsBytes checks the stored JSON is the upload with only
// the video value replaced, whatever the whitespace and key order.
func TestSpliceVideoKeepsBytes(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString(tinyMP4(40, 'z'))
	body := []byte(`{ "session_id" : "s-1", "video"  :  {"mp4":"` + b64 + `", "container":"mp4","x":{"y":[1,2]}} ,"seq":0,` +
		`"kind":"video","schema_version":1,"started_at":10,"ended_at":20,"viewport":{"width":1,"height":2},"extra":"kept \"video\""}`)
	c, err := parseChunk(body, DefaultMaxVideoBytes)
	if err != nil {
		t.Fatal(err)
	}
	want := `{ "session_id" : "s-1", "video":{"bytes":40,"container":"mp4","x":{"y":[1,2]}} ,"seq":0,` +
		`"kind":"video","schema_version":1,"started_at":10,"ended_at":20,"viewport":{"width":1,"height":2},"extra":"kept \"video\""}`
	if string(c.stored) != want {
		t.Fatalf("stored:\n%s\nwant:\n%s", c.stored, want)
	}
	if c.Viewport.Scale != 1 || c.SessionID != "s-1" {
		t.Fatalf("chunk: %+v", c)
	}
	// A duplicate video key is rejected.
	dup := []byte(`{"kind":"video","video":{},"video":{}}`)
	if _, err := parseChunk(dup, DefaultMaxVideoBytes); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate video: %v", err)
	}
}
