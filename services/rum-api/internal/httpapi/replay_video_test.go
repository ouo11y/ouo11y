package httpapi

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
)

// fakeMP4 returns n bytes that pass the mp4 check: a 24-byte ftyp box
// (`\x00\x00\x00\x18ftypmp42...`) followed by filler derived from tag.
func fakeMP4(n int, tag byte) []byte {
	b := []byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
	for i := 0; len(b) < n; i++ {
		b = append(b, tag+byte(i%13))
	}
	return b[:n]
}

func videoBody(t *testing.T, id string, seq int, start int64, mp4 []byte, frameCount int, touches []map[string]any) []byte {
	t.Helper()
	if touches == nil {
		touches = []map[string]any{}
	}
	b, err := json.Marshal(map[string]any{
		"kind": "video", "schema_version": 1, "session_id": id, "seq": seq,
		"started_at": start, "ended_at": start + 5000,
		"viewport": map[string]any{"width": 288, "height": 624, "scale": 1}, "platform": "ios",
		"video": map[string]any{"container": "mp4", "encoding": "h264", "duration_ms": 5000, "frame_count": frameCount,
			"frame_rate": 1, "mp4": base64.StdEncoding.EncodeToString(mp4)},
		"touches": touches,
		"source":  map[string]any{"vendor": "sentry", "replay_id": "0123456789abcdef0123456789abcdef", "segment_id": seq, "replay_type": "session"},
		"masked":  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func get(t *testing.T, url string, headers ...string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

func TestVideoReplayHTTP(t *testing.T) {
	ts, _, _ := newTestServer(t)
	url := ts.URL + "/v1/replay/chunks"
	id := "video-http-1"
	mp4a, mp4b := fakeMP4(300, 'a'), fakeMP4(700, 'k')
	touches := []map[string]any{{"ts": 6100, "x": 120.5, "y": 410, "phase": "began"}, {"ts": 6300, "x": 120.5, "y": 410, "phase": "ended"}}

	code, ack := post(t, url, videoBody(t, id, 0, 1000, mp4a, 5, nil), true)
	if code != http.StatusAccepted || ack["kind"] != "video" || ack["frames"] != float64(5) || ack["touches"] != float64(0) ||
		ack["events"] != float64(0) || ack["project_id"] != testProject || ack["session_id"] != id || ack["seq"] != float64(0) || ack["accepted"] != true {
		t.Fatalf("video post: %d %v", code, ack)
	}
	if code, ack = post(t, url, videoBody(t, id, 1, 6000, mp4b, 4, touches), false); code != http.StatusAccepted || ack["touches"] != float64(2) || ack["frames"] != float64(4) {
		t.Fatalf("video post 2: %d %v", code, ack)
	}
	// Validation is 400, nothing stored.
	bad := videoBody(t, id, 2, 11000, append([]byte("\x00\x00\x00\x18moov"), make([]byte, 30)...), 1, nil)
	if code, ack = post(t, url, bad, false); code != http.StatusBadRequest || !strings.Contains(ack["error"].(string), "ftyp") {
		t.Fatalf("bad ftyp: %d %v", code, ack)
	}

	// Meta.
	resp, body := get(t, ts.URL+"/v1/sessions/"+id+"/replay")
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil || resp.StatusCode != 200 {
		t.Fatalf("meta: %d %s", resp.StatusCode, body)
	}
	vp := raw["viewport"].(map[string]any)
	src := raw["source"].(map[string]any)
	if raw["kind"] != "video" || raw["platform"] != "ios" || vp["width"] != float64(288) || raw["frame_count"] != float64(9) ||
		raw["touch_count"] != float64(2) || raw["chunk_count"] != float64(2) || src["vendor"] != "sentry" || src["replay_id"] != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("meta: %s", body)
	}
	chunks := raw["chunks"].([]any)
	c0 := chunks[0].(map[string]any)
	if c0["duration_ms"] != float64(5000) || c0["video_bytes"] != float64(300) || c0["frame_count"] != float64(5) {
		t.Fatalf("meta chunk 0: %v", c0)
	}

	// Manifest, gzip negotiated.
	resp, body = get(t, ts.URL+"/v1/sessions/"+id+"/replay/video", "Accept-Encoding", "gzip")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Encoding") != "gzip" || resp.Header.Get("X-Ouo-Replay-Kind") != "video" ||
		resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("manifest: %d %v", resp.StatusCode, resp.Header)
	}
	gr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(gr)
	var man replay.VideoManifest
	if err := json.Unmarshal(body, &man); err != nil {
		t.Fatalf("manifest body: %v %s", err, body)
	}
	if man.SessionID != id || man.Kind != "video" || man.Platform != "ios" || man.Viewport == nil || man.Viewport.Height != 624 ||
		man.StartedAt != 1000 || man.EndedAt != 11000 || len(man.Segments) != 2 || len(man.Touches) != 2 ||
		man.Source == nil || man.Source.ReplayID != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("manifest: %s", body)
	}
	if s := man.Segments[1]; s.Seq != 1 || s.StartedAt != 6000 || s.EndedAt != 11000 || s.DurationMs != 5000 || s.FrameCount != 4 || s.Bytes != 700 ||
		s.Path != "/v1/sessions/"+id+"/replay/video/1" {
		t.Fatalf("segment 1: %+v", s)
	}
	// Plain manifest, exact key order of the spec.
	resp, body = get(t, ts.URL+"/v1/sessions/"+id+"/replay/video")
	if resp.Header.Get("Content-Encoding") != "" || !bytes.HasPrefix(body, []byte(`{"session_id":"`+id+`","kind":"video","viewport":{"width":288,"height":624,"scale":1},"platform":"ios","started_at":1000,"ended_at":11000,"segments":[{"seq":0,"started_at":1000,"ended_at":6000,"duration_ms":5000,"frame_count":5,"bytes":300,"path":"/v1/sessions/`+id+`/replay/video/0"}`)) {
		t.Fatalf("plain manifest: %s", body)
	}
	if !bytes.Contains(body, []byte(`"touches":[{"phase":"began","ts":6100,"x":120.5,"y":410},`)) ||
		!bytes.HasSuffix(bytes.TrimSpace(body), []byte(`"source":{"vendor":"sentry","replay_id":"0123456789abcdef0123456789abcdef"}}`)) {
		t.Fatalf("plain manifest tail: %s", body)
	}

	// Segment: full body.
	seg := ts.URL + "/v1/sessions/" + id + "/replay/video/1"
	resp, body = get(t, seg)
	lastMod, etag := resp.Header.Get("Last-Modified"), resp.Header.Get("ETag")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "video/mp4" || resp.Header.Get("Accept-Ranges") != "bytes" ||
		lastMod == "" || etag == "" || resp.Header.Get("X-Ouo-Replay-Kind") != "video" || !bytes.Equal(body, mp4b) || resp.Header.Get("Content-Length") != "700" {
		t.Fatalf("segment: %d %v %d bytes", resp.StatusCode, resp.Header, len(body))
	}
	// Range bytes=0-99: 206 and exactly those bytes.
	resp, body = get(t, seg, "Range", "bytes=0-99")
	if resp.StatusCode != http.StatusPartialContent || resp.Header.Get("Content-Range") != "bytes 0-99/700" || !bytes.Equal(body, mp4b[:100]) {
		t.Fatalf("range: %d %v %d bytes", resp.StatusCode, resp.Header, len(body))
	}
	resp, body = get(t, seg, "Range", "bytes=650-")
	if resp.StatusCode != http.StatusPartialContent || !bytes.Equal(body, mp4b[650:]) {
		t.Fatalf("open range: %d %d bytes", resp.StatusCode, len(body))
	}
	if resp, _ = get(t, seg, "Range", "bytes=900-"); resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("unsatisfiable range: %d", resp.StatusCode)
	}
	// Conditional GET.
	if resp, _ = get(t, seg, "If-Modified-Since", lastMod); resp.StatusCode != http.StatusNotModified {
		t.Fatalf("if-modified-since: %d", resp.StatusCode)
	}
	if resp, _ = get(t, seg, "If-None-Match", etag); resp.StatusCode != http.StatusNotModified {
		t.Fatalf("if-none-match: %d", resp.StatusCode)
	}
	// HEAD.
	if hr, err := http.Head(seg); err != nil || hr.StatusCode != 200 || hr.Header.Get("Content-Length") != "700" {
		t.Fatalf("head: %v %v", err, hr)
	}
	// Missing segment / session, bad seq.
	if resp, _ = get(t, ts.URL+"/v1/sessions/"+id+"/replay/video/7"); resp.StatusCode != 404 {
		t.Fatalf("missing segment: %d", resp.StatusCode)
	}
	if resp, _ = get(t, ts.URL+"/v1/sessions/no-such/replay/video/0"); resp.StatusCode != 404 {
		t.Fatalf("missing session segment: %d", resp.StatusCode)
	}
	if resp, _ = get(t, ts.URL+"/v1/sessions/no-such/replay/video"); resp.StatusCode != 404 {
		t.Fatalf("missing session manifest: %d", resp.StatusCode)
	}
	for _, s := range []string{"x", "-1", "1000000"} {
		if resp, _ = get(t, ts.URL+"/v1/sessions/"+id+"/replay/video/"+s); resp.StatusCode != 400 {
			t.Fatalf("seq %s: %d", s, resp.StatusCode)
		}
	}

	// Re-post seq 1: both files replaced. Within the same second the old
	// ETag no longer matches, so a cached copy is not reused.
	mp4c := fakeMP4(150, 'z')
	if code, ack = post(t, url, videoBody(t, id, 1, 6000, mp4c, 2, nil), false); code != http.StatusAccepted {
		t.Fatalf("re-post: %d %v", code, ack)
	}
	if resp, body = get(t, seg, "If-None-Match", etag, "If-Modified-Since", lastMod); resp.StatusCode != 200 || !bytes.Equal(body, mp4c) || resp.Header.Get("Content-Length") != "150" {
		t.Fatalf("segment after re-post: %d, %d bytes", resp.StatusCode, len(body))
	}
	var m replay.Meta
	if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay", &m); code != 200 || m.ChunkCount != 2 || m.FrameCount != 7 || m.TouchCount != 0 {
		t.Fatalf("meta after re-post: %+v", m)
	}

	// 409 matrix: other readers on a video replay...
	for _, p := range []string{"/replay/events", "/replay/frames"} {
		resp, body = get(t, ts.URL+"/v1/sessions/"+id+p)
		if resp.StatusCode != http.StatusConflict || !strings.Contains(string(body), "/replay/video") {
			t.Fatalf("%s on video: %d %s", p, resp.StatusCode, body)
		}
	}
	// ...video readers on rrweb and frames replays...
	rrID, frID := "rrweb-v-1", "frames-v-1"
	rr, _ := json.Marshal(map[string]any{"session_id": rrID, "seq": 0, "started_at": 1000, "ended_at": 2000, "events": []any{map[string]any{"type": 4}}})
	if code, _ := post(t, url, rr, false); code != http.StatusAccepted {
		t.Fatal("rrweb post")
	}
	if code, _ := post(t, url, framesBody(t, frID, 0, 1000, []string{jpegB64(t, 0)}, nil), false); code != http.StatusAccepted {
		t.Fatal("frames post")
	}
	for sid, other := range map[string]string{rrID: "/replay/events", frID: "/replay/frames"} {
		for _, p := range []string{"/replay/video", "/replay/video/0"} {
			resp, body = get(t, ts.URL+"/v1/sessions/"+sid+p)
			if resp.StatusCode != http.StatusConflict || !strings.Contains(string(body), other) {
				t.Fatalf("%s on %s: %d %s", p, sid, resp.StatusCode, body)
			}
		}
	}
	// ...and chunks of another kind, both directions.
	if code, _ := post(t, url, videoBody(t, rrID, 1, 6000, mp4a, 1, nil), false); code != http.StatusConflict {
		t.Fatalf("video onto rrweb: %d", code)
	}
	if code, _ := post(t, url, videoBody(t, frID, 1, 6000, mp4a, 1, nil), false); code != http.StatusConflict {
		t.Fatalf("video onto frames: %d", code)
	}
	if code, _ := post(t, url, framesBody(t, id, 5, 30000, []string{jpegB64(t, 0)}, nil), false); code != http.StatusConflict {
		t.Fatalf("frames onto video: %d", code)
	}
	rr, _ = json.Marshal(map[string]any{"session_id": id, "seq": 5, "started_at": 30000, "ended_at": 31000, "events": []any{map[string]any{"type": 3}}})
	if code, _ := post(t, url, rr, false); code != http.StatusConflict {
		t.Fatalf("rrweb onto video: %d", code)
	}

	// Delete.
	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/v1/sessions/"+id+"/replay", nil)
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if resp, _ = get(t, seg); resp.StatusCode != 404 {
		t.Fatalf("segment after delete: %d", resp.StatusCode)
	}
}

func TestVideoChunkSizeLimits(t *testing.T) {
	ts, _, _ := newTestServer(t)
	url := ts.URL + "/v1/replay/chunks"
	// A 6 MiB mp4 is an ~8 MiB body: above the rrweb and the frames limits,
	// accepted for kind video (plain and gzip).
	mid := videoBody(t, "mid-video", 0, 1000, fakeMP4(6<<20, 'a'), 5, nil)
	if len(mid) <= 8<<20 {
		t.Fatalf("test body %d not above the frames limit", len(mid))
	}
	for i, gzipIt := range []bool{false, true} {
		b := videoBody(t, "mid-video", i, 1000+int64(i)*5000, fakeMP4(6<<20, 'a'), 5, nil)
		if code, ack := post(t, url, b, gzipIt); code != http.StatusAccepted || ack["kind"] != "video" {
			t.Fatalf("mid video gzip=%v: %d %v", gzipIt, code, ack)
		}
	}
	// One byte above MAX_VIDEO_CHUNK_BYTES decoded: the body fits, the store says 413.
	over := videoBody(t, "over-video", 0, 1000, fakeMP4(8<<20+1, 'a'), 5, nil)
	if code, ack := post(t, url, over, false); code != http.StatusRequestEntityTooLarge || !strings.Contains(ack["error"].(string), "video.mp4") {
		t.Fatalf("over video: %d %v", code, ack)
	}
	// A body above the video body limit: 413 before parsing (plain and gzip).
	huge := videoBody(t, "huge-video", 0, 1000, fakeMP4(10<<20, 'a'), 5, nil)
	for _, gzipIt := range []bool{false, true} {
		if code, _ := post(t, url, huge, gzipIt); code != http.StatusRequestEntityTooLarge {
			t.Fatalf("huge video gzip=%v: %d", gzipIt, code)
		}
	}
	for _, id := range []string{"over-video", "huge-video"} {
		if code := getJSON(t, ts.URL+"/v1/sessions/"+id+"/replay", nil); code != 404 {
			t.Fatalf("%s must not be stored: %d", id, code)
		}
	}
	// A frames chunk the size of the mid video body is still 413 (the reader
	// cap grew for video, the frames limit did not).
	bigFrames := framesBody(t, "big-frames", 0, 1000, []string{jpegB64(t, 6<<20+512<<10)}, nil)
	if len(bigFrames) <= 8<<20 {
		t.Fatalf("frames body %d", len(bigFrames))
	}
	if code, ack := post(t, url, bigFrames, false); code != http.StatusRequestEntityTooLarge || !strings.Contains(ack["error"].(string), "frames chunk") {
		t.Fatalf("big frames: %d %v", code, ack)
	}

	// A smaller configured limit is honoured end to end.
	ts2, _, _ := newTestServerWith(t, func(o *Options) { o.MaxVideoChunkBytes = 5 << 20 })
	if code, _ := post(t, ts2.URL+"/v1/replay/chunks", mid, false); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("6 MiB mp4 with a 5 MiB limit: %d", code)
	}
}

func TestVideoSessionFields(t *testing.T) {
	ts, _, _ := newTestServer(t)
	url := ts.URL + "/v1/replay/chunks"
	// mobile-1 is a session in the Loki fixture.
	for i, fc := range []int{5, 3} {
		if code, ack := post(t, url, videoBody(t, "mobile-1", i, 1000+int64(i)*5000, fakeMP4(200, 'a'), fc, nil), false); code != http.StatusAccepted {
			t.Fatalf("post: %d %v", code, ack)
		}
	}
	var list struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h", &list); code != 200 {
		t.Fatalf("list: %d", code)
	}
	found := false
	for _, rec := range list.Sessions {
		if rec["session_id"] != "mobile-1" {
			continue
		}
		found = true
		if rec["has_replay"] != true || rec["replay_kind"] != "video" || rec["replay_duration_ms"] != float64(10000) || rec["replay_frame_count"] != float64(8) {
			t.Fatalf("list record: %v", rec)
		}
	}
	if !found {
		t.Fatal("mobile-1 not listed")
	}
	var detail map[string]any
	if code := getJSON(t, ts.URL+"/v1/sessions/mobile-1", &detail); code != 200 ||
		detail["replay_kind"] != "video" || detail["replay_duration_ms"] != float64(10000) || detail["replay_frame_count"] != float64(8) {
		t.Fatalf("detail: %d %v %v %v", code, detail["replay_kind"], detail["replay_duration_ms"], detail["replay_frame_count"])
	}
}

func TestVideoReadToken(t *testing.T) {
	ts, _, _ := newTestServerWith(t, func(o *Options) { o.ReadToken = readToken })
	id := "video-auth-1"
	mp4 := fakeMP4(300, 'q')
	if code, ack := post(t, ts.URL+"/v1/replay/chunks", videoBody(t, id, 0, 1000, mp4, 1, nil), false); code != http.StatusAccepted {
		t.Fatalf("post: %d %v", code, ack)
	}
	for _, p := range []string{"/replay/video", "/replay/video/0"} {
		if resp, _ := get(t, ts.URL+"/v1/sessions/"+id+p); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s without token: %d", p, resp.StatusCode)
		}
	}
	resp, body := get(t, ts.URL+"/v1/sessions/"+id+"/replay/video/0", "Authorization", "Bearer "+readToken, "Range", "bytes=0-99")
	if resp.StatusCode != http.StatusPartialContent || !bytes.Equal(body, mp4[:100]) {
		t.Fatalf("with token: %d %d bytes", resp.StatusCode, len(body))
	}
	if resp, _ := get(t, ts.URL+"/v1/sessions/"+id+"/replay/video", "Authorization", "Bearer "+readToken); resp.StatusCode != 200 {
		t.Fatalf("manifest with token: %d", resp.StatusCode)
	}
}
