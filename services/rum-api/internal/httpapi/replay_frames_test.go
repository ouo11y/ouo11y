package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
)

func jpegB64(t *testing.T, pad int) string {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewGray(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	if pad > 0 {
		// Still starts with FF D8; the validator only checks the marker.
		b = append(b, make([]byte, pad)...)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func framesBody(t *testing.T, id string, seq int, start int64, jpegs []string, touches []map[string]any) []byte {
	t.Helper()
	frames := []map[string]any{}
	for i, j := range jpegs {
		frames = append(frames, map[string]any{"ts": start + int64(i)*1000, "jpeg": j, "reason": "timer", "n": seq*10 + i})
	}
	if touches == nil {
		touches = []map[string]any{}
	}
	b, _ := json.Marshal(map[string]any{
		"kind": "frames", "schema_version": 1, "session_id": id, "seq": seq,
		"started_at": start, "ended_at": start + 5000,
		"viewport": map[string]any{"width": 393, "height": 852, "scale": 0.5}, "platform": "ios",
		"frames": frames, "touches": touches, "masked": true,
	})
	return b
}

func post(t *testing.T, url string, body []byte, gzipIt bool) (int, map[string]any) {
	t.Helper()
	var r io.Reader = bytes.NewReader(body)
	if gzipIt {
		var gz bytes.Buffer
		gw := gzip.NewWriter(&gz)
		gw.Write(body)
		gw.Close()
		r = &gz
	}
	req, _ := http.NewRequest(http.MethodPost, url, r)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ProjectIDHeader, testProject)
	if gzipIt {
		req.Header.Set("Content-Encoding", "gzip")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestFramesReplayHTTP(t *testing.T) {
	ts, _, _ := newTestServer(t)
	url := ts.URL + "/v1/replay/chunks"
	id := "frames-http-1"
	small := jpegB64(t, 0)
	touches := []map[string]any{{"ts": 6100, "x": 120.5, "y": 640, "phase": "began"}, {"ts": 6300, "x": 120.5, "y": 640, "phase": "ended"}}

	code, ack := post(t, url, framesBody(t, id, 0, 1000, []string{small, small}, nil), true)
	if code != http.StatusAccepted || ack["kind"] != "frames" || ack["frames"].(float64) != 2 || ack["touches"].(float64) != 0 || ack["events"].(float64) != 0 {
		t.Fatalf("frames post: %d %v", code, ack)
	}
	if code, ack = post(t, url, framesBody(t, id, 1, 6000, []string{small}, touches), false); code != http.StatusAccepted || ack["touches"].(float64) != 2 {
		t.Fatalf("frames post 2: %d %v", code, ack)
	}
	// Validation surfaces as 400.
	if code, ack = post(t, url, framesBody(t, id, 2, 11000, []string{"bm90IGEganBlZw=="}, nil), false); code != http.StatusBadRequest || !strings.Contains(ack["error"].(string), "FF D8") {
		t.Fatalf("bad magic: %d %v", code, ack)
	}
	// Mixed kinds: rrweb chunk onto a frames session is 409 and not stored.
	rr, _ := json.Marshal(map[string]any{"session_id": id, "seq": 2, "started_at": 11000, "ended_at": 12000, "events": []any{map[string]any{"type": 3}}})
	if code, ack = post(t, url, rr, false); code != http.StatusConflict || ack["error"] == nil {
		t.Fatalf("mixed kinds: %d %v", code, ack)
	}

	var m replay.Meta
	if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay", &m); code != 200 {
		t.Fatalf("meta: %d", code)
	}
	if m.Kind != "frames" || m.ChunkCount != 2 || m.FrameCount != 3 || m.TouchCount != 2 || m.Platform != "ios" || m.Viewport == nil || m.Viewport.Width != 393 || m.StartedAt != 1000 || m.EndedAt != 11000 {
		t.Fatalf("meta: %+v", m)
	}
	// Raw JSON shape of the meta.
	resp, _ := http.Get(ts.URL + "/v1/sessions/" + id + "/replay")
	var rawMeta map[string]any
	json.NewDecoder(resp.Body).Decode(&rawMeta)
	for _, k := range []string{"kind", "viewport", "platform", "frame_count", "touch_count", "chunks"} {
		if _, ok := rawMeta[k]; !ok {
			t.Errorf("meta json missing %s", k)
		}
	}

	// GET frames, gzip negotiated, chunks concatenated in seq order.
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/sessions/"+id+"/replay/frames", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Header.Get("Content-Encoding") != "gzip" || resp.Header.Get("X-Ouo-Replay-Kind") != "frames" {
		t.Fatalf("frames: %d %v", resp.StatusCode, resp.Header)
	}
	gr, _ := gzip.NewReader(resp.Body)
	body, _ := io.ReadAll(gr)
	var fr struct {
		SessionID string           `json:"session_id"`
		Kind      string           `json:"kind"`
		Viewport  replay.Viewport  `json:"viewport"`
		Platform  string           `json:"platform"`
		StartedAt int64            `json:"started_at"`
		EndedAt   int64            `json:"ended_at"`
		Frames    []map[string]any `json:"frames"`
		Touches   []map[string]any `json:"touches"`
	}
	if err := json.Unmarshal(body, &fr); err != nil {
		t.Fatalf("frames body: %v %.200s", err, body)
	}
	if fr.SessionID != id || fr.Kind != "frames" || fr.Platform != "ios" || fr.Viewport.Scale != 0.5 || fr.StartedAt != 1000 || fr.EndedAt != 11000 {
		t.Fatalf("frames head: %+v", fr)
	}
	if len(fr.Frames) != 3 || len(fr.Touches) != 2 {
		t.Fatalf("frames/touches: %d/%d", len(fr.Frames), len(fr.Touches))
	}
	for i, want := range []int{0, 1, 10} {
		if int(fr.Frames[i]["n"].(float64)) != want || fr.Frames[i]["jpeg"] != small {
			t.Fatalf("frame order at %d: %v", i, fr.Frames[i]["n"])
		}
	}
	// Plain (no gzip) works too and starts with the object.
	resp, _ = client.Get(ts.URL + "/v1/sessions/" + id + "/replay/frames")
	body, _ = io.ReadAll(resp.Body)
	if resp.Header.Get("Content-Encoding") != "" || !bytes.HasPrefix(body, []byte(`{"session_id":"`+id+`","kind":"frames"`)) {
		t.Fatalf("plain frames: %v %.100s", resp.Header, body)
	}

	// 409 matrix.
	if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay/events", nil); code != http.StatusConflict {
		t.Fatalf("events on frames replay: %d", code)
	}
	rrID := "rrweb-http-1"
	rr, _ = json.Marshal(map[string]any{"session_id": rrID, "seq": 0, "started_at": 1000, "ended_at": 2000, "events": []any{map[string]any{"type": 4}}})
	if code, ack := post(t, url, rr, false); code != http.StatusAccepted || ack["kind"] != "rrweb" {
		t.Fatalf("rrweb post: %d %v", code, ack)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/"+rrID+"/replay/frames", nil); code != http.StatusConflict {
		t.Fatalf("frames on rrweb replay: %d", code)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/"+rrID+"/replay/events", nil); code != 200 {
		t.Fatalf("events on rrweb replay: %d", code)
	}
	if code, _ := post(t, url, framesBody(t, rrID, 1, 6000, []string{small}, nil), false); code != http.StatusConflict {
		t.Fatalf("frames chunk onto rrweb session: %d", code)
	}
	m = replay.Meta{}
	if code := getJSON(t, ts.URL+"/v1/sessions/"+rrID+"/replay", &m); code != 200 || m.Kind != "rrweb" || m.FrameCount != 0 || m.Viewport != nil || m.Platform != "" {
		t.Fatalf("rrweb meta: %d %+v", code, m)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/no-such/replay/frames", nil); code != 404 {
		t.Fatalf("frames 404: %d", code)
	}
	// Delete works for frames too.
	req, _ = http.NewRequest(http.MethodDelete, ts.URL+"/v1/sessions/"+id+"/replay", nil)
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay/frames", nil); code != 404 {
		t.Fatalf("frames after delete: %d", code)
	}
}

func TestChunkSizeLimitsPerKind(t *testing.T) {
	ts, _, _ := newTestServer(t)
	url := ts.URL + "/v1/replay/chunks"
	// rrweb above 4 MiB: 413 even though the reader accepts up to 8 MiB.
	bigEvent := map[string]any{"type": 3, "data": strings.Repeat("x", 4<<20)}
	rr, _ := json.Marshal(map[string]any{"session_id": "big-rrweb", "seq": 0, "started_at": 1, "ended_at": 2, "events": []any{bigEvent}})
	for _, gzipIt := range []bool{false, true} {
		if code, ack := post(t, url, rr, gzipIt); code != http.StatusRequestEntityTooLarge || !strings.Contains(ack["error"].(string), "rrweb") {
			t.Fatalf("big rrweb gzip=%v: %d %v", gzipIt, code, ack)
		}
	}
	// rrweb just under 4 MiB passes.
	okEvent := map[string]any{"type": 3, "data": strings.Repeat("x", 3<<20)}
	rr, _ = json.Marshal(map[string]any{"session_id": "ok-rrweb", "seq": 0, "started_at": 1, "ended_at": 2, "events": []any{okEvent}})
	if code, ack := post(t, url, rr, true); code != http.StatusAccepted {
		t.Fatalf("3 MiB rrweb: %d %v", code, ack)
	}
	// frames between 4 and 8 MiB: accepted (plain and gzip).
	mid := framesBody(t, "mid-frames", 0, 1000, []string{jpegB64(t, 4<<20)}, nil)
	if len(mid) <= 4<<20 || len(mid) >= 8<<20 {
		t.Fatalf("test body size %d not between limits", len(mid))
	}
	for i, gzipIt := range []bool{false, true} {
		b := framesBody(t, "mid-frames", i, 1000+int64(i)*5000, []string{jpegB64(t, 4<<20)}, nil)
		if code, ack := post(t, url, b, gzipIt); code != http.StatusAccepted || ack["kind"] != "frames" {
			t.Fatalf("mid frames gzip=%v: %d %v", gzipIt, code, ack)
		}
	}
	// frames above 8 MiB: 413 (plain hits the body reader, gzip hits the decompressed limit).
	huge := framesBody(t, "huge-frames", 0, 1000, []string{jpegB64(t, 7<<20)}, nil)
	for _, gzipIt := range []bool{false, true} {
		if code, _ := post(t, url, huge, gzipIt); code != http.StatusRequestEntityTooLarge {
			t.Fatalf("huge frames gzip=%v: %d", gzipIt, code)
		}
	}
	if code := getJSON(t, ts.URL+"/v1/sessions/huge-frames/replay", nil); code != 404 {
		t.Fatalf("huge frames must not be stored: %d", code)
	}
}

func TestSessionReplayKind(t *testing.T) {
	ts, _, store := newTestServer(t)
	ctx := context.Background()
	if _, err := store.Put(ctx, "demo", []byte(`{"session_id":"`+realSession+`","seq":0,"started_at":1,"ended_at":2,"events":[{"type":4}]}`), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(ctx, "demo", framesBody(t, "mobile-1", 0, 1000, []string{jpegB64(t, 0)}, nil), nil); err != nil {
		t.Fatal(err)
	}
	var list listResponse
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h", &list); code != 200 || list.Count != 2 {
		t.Fatalf("list: %d %+v", code, list)
	}
	for _, rec := range list.Sessions {
		switch rec.SessionID {
		case "mobile-1":
			if !rec.HasReplay || rec.ReplayKind == nil || *rec.ReplayKind != "frames" {
				t.Fatalf("mobile record: %+v", rec)
			}
		case realSession:
			if !rec.HasReplay || rec.ReplayKind == nil || *rec.ReplayKind != "rrweb" {
				t.Fatalf("web record: %+v", rec)
			}
		}
	}
	// Detail: raw JSON carries replay_kind as a string, or null without a replay.
	resp, _ := http.Get(ts.URL + "/v1/sessions/mobile-1")
	var raw map[string]any
	json.NewDecoder(resp.Body).Decode(&raw)
	if raw["replay_kind"] != "frames" || raw["has_replay"] != true {
		t.Fatalf("detail replay_kind: %v", raw["replay_kind"])
	}
	// The frames chunk above spans [1000, 1000+n] with one frame.
	if d, ok := raw["replay_duration_ms"].(float64); !ok || d < 0 || raw["replay_frame_count"] != float64(1) {
		t.Fatalf("detail replay duration/frames: %v %v", raw["replay_duration_ms"], raw["replay_frame_count"])
	}
	store.Delete(ctx, "mobile-1")
	resp, _ = http.Get(ts.URL + "/v1/sessions/mobile-1")
	raw = nil
	json.NewDecoder(resp.Body).Decode(&raw)
	if v, ok := raw["replay_kind"]; !ok || v != nil || raw["has_replay"] != false {
		t.Fatalf("detail without replay: %v %v", raw["replay_kind"], raw["has_replay"])
	}
	for _, k := range []string{"replay_duration_ms", "replay_frame_count"} {
		if v, ok := raw[k]; !ok || v != nil {
			t.Fatalf("detail without replay: %s=%v", k, v)
		}
	}
}

func TestReplaySummaryFromMeta(t *testing.T) {
	ptr64 := func(v int64) *int64 { return &v }
	ptr := func(v int) *int { return &v }
	cases := []struct {
		name   string
		meta   replay.Meta
		wantD  *int64
		wantFC *int
	}{
		{"frames", replay.Meta{Kind: replay.KindFrames, StartedAt: 1791471538578, EndedAt: 1791471548578, FrameCount: 12}, ptr64(10000), ptr(12)},
		{"rrweb", replay.Meta{Kind: replay.KindRRWeb, StartedAt: 100, EndedAt: 250}, ptr64(150), nil},
		{"video", replay.Meta{Kind: replay.KindVideo, StartedAt: 1000, EndedAt: 11000, FrameCount: 10}, ptr64(10000), ptr(10)},
		{"single instant", replay.Meta{Kind: replay.KindFrames, StartedAt: 5, EndedAt: 5, FrameCount: 1}, ptr64(0), ptr(1)},
		{"no timestamps", replay.Meta{Kind: replay.KindFrames, FrameCount: 3}, nil, ptr(3)},
		{"ended before started", replay.Meta{Kind: replay.KindRRWeb, StartedAt: 10, EndedAt: 4}, nil, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, fc := replaySummary(tc.meta)
			if (d == nil) != (tc.wantD == nil) || (d != nil && *d != *tc.wantD) {
				t.Fatalf("duration: got %v want %v", d, tc.wantD)
			}
			if (fc == nil) != (tc.wantFC == nil) || (fc != nil && *fc != *tc.wantFC) {
				t.Fatalf("frame count: got %v want %v", fc, tc.wantFC)
			}
		})
	}
}
