package ouosentryreceiver

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
)

func newMuninnTx(t *testing.T) *tx {
	x := newTx(t)
	x.r.cfg.ReplayWire = ReplayWireMuninn
	return x
}

// muninnChunks returns the ouo.replay.chunk records and checks the attributes
// Muninn requires (docs/specs/muninn.md section 3.1) on each of them.
func (x *tx) muninnChunks(t *testing.T) []rec {
	t.Helper()
	var out []rec
	for _, ld := range x.logs.AllLogs() {
		for i := 0; i < ld.ResourceLogs().Len(); i++ {
			rl := ld.ResourceLogs().At(i)
			for j := 0; j < rl.ScopeLogs().Len(); j++ {
				sl := rl.ScopeLogs().At(j)
				if sl.Scope().Name() != replayScope {
					continue
				}
				if p, _ := rl.Resource().Attributes().Get(attrProjectID); p.Str() != "mobile-store" {
					t.Errorf("resource project: %q", p.Str())
				}
				for k := 0; k < sl.LogRecords().Len(); k++ {
					lr := sl.LogRecords().At(k)
					if lr.EventName() != eventReplayChunk {
						t.Errorf("event name %q", lr.EventName())
					}
					a := lr.Attributes().AsRaw()
					body := lr.Body().Bytes().AsRaw()
					sum := sha256.Sum256(body)
					for _, key := range []string{"session.id", "ouo.replay.id", "ouo.replay.stream.id"} {
						if s, _ := a[key].(string); len(s) != 32 || strings.ToLower(s) != s {
							t.Errorf("%s = %v", key, a[key])
						}
					}
					if a["ouo.replay.sha256"] != hex.EncodeToString(sum[:]) || a["ouo.replay.byte_size"] != int64(len(body)) ||
						a["ouo.replay.start_time"].(int64) > a["ouo.replay.end_time"].(int64) ||
						a["ouo.replay.segment.index"].(int64) < 0 || a["ouo.replay.mode"] != "session" ||
						a["ouo.replay.source.vendor"] != "sentry" || a["ouo.replay.chunk"] != true {
						t.Errorf("chunk attributes: %+v", a)
					}
					if lr.Timestamp().AsTime().UnixMilli() != a["ouo.replay.start_time"] {
						t.Errorf("timestamp %v vs start_time %v", lr.Timestamp().AsTime(), a["ouo.replay.start_time"])
					}
					out = append(out, rec{name: lr.EventName(), attrs: a, body: body})
				}
			}
		}
	}
	return out
}

// legacyChunks counts records in the legacy video chunk shape (ouo.replay.kind).
func (x *tx) legacyChunks() int {
	n := 0
	for _, r := range x.records() {
		if _, ok := r.attrs[attrReplayKind]; ok {
			n++
		}
	}
	return n
}

func TestMuninnWireVideo(t *testing.T) {
	x := newMuninnTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	x.send(t, hdr("sentry.cocoa"),
		item("event", map[string]any{"event_id": "e1", "level": "error", "message": "x", "contexts": map[string]any{"replay": map[string]any{"replay_id": replay}}}),
		item("session", session(sid1, false, "ok", 1, "2026-10-14T10:00:05Z")))
	x.send(t, hdr("sentry.cocoa"), replayItem(replay, 0, 1791972000000, device))
	x.send(t, hdr("sentry.cocoa"), replayItem(replay, 1, 1791972005000, device))
	cs := x.muninnChunks(t)
	if len(cs) != 2 {
		t.Fatalf("chunks: %d", len(cs))
	}
	if n := x.legacyChunks(); n != 0 {
		t.Errorf("legacy video chunks on the muninn wire: %d", n)
	}
	c := cs[1]
	a := c.attrs
	if a["session.id"] != sid1 || a["ouo.replay.id"] != replay || a["ouo.replay.stream.id"] != replay ||
		a["ouo.replay.sequence"] != int64(1) || a["ouo.replay.segment.index"] != int64(1) || a["ouo.replay.keyframe"] != true ||
		a["ouo.replay.format"] != formatVideo || a["ouo.replay.encoding"] != "identity" || a["ouo.replay.masked"] != true ||
		a["ouo.replay.start_time"] != int64(1791972005000) || a["ouo.replay.end_time"] != int64(1791972010000) {
		t.Errorf("video chunk: %+v", a)
	}
	line, mp4, ok := bytes.Cut(c.body.([]byte), []byte("\n"))
	if !ok || !bytes.Equal(mp4, fakeMP4) {
		t.Fatalf("body is not header line + mp4: %q", c.body)
	}
	var h videoHeader
	if err := json.Unmarshal(line, &h); err != nil {
		t.Fatal(err)
	}
	if h.Type != "video" || h.T != 1791972005000 || h.End != 1791972010000 || h.W != 390 || h.H != 844 || h.Scale != 1 ||
		h.FPS != 1 || h.Frames != 5 || h.MP4 != len(fakeMP4) || len(h.Touches) != 2 ||
		h.Touches[0] != (videoTouch{T: 1791972006000, X: 120.5, Y: 410, Phase: "began"}) {
		t.Errorf("header: %+v", h)
	}
}

const webReplay = "b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6"

// webReplayItems is a browser envelope's replay_event + replay_recording pair.
// The recording array is zlib compressed after the header line, as the
// browser SDK sends it.
func webReplayItems(t *testing.T, segment int, startMS int64, events string) []string {
	ev, _ := json.Marshal(map[string]any{"type": "replay_event", "replay_id": webReplay, "segment_id": segment, "replay_type": "session",
		"timestamp": float64(startMS) / 1000, "user": map[string]any{"id": 69}, "platform": "javascript"})
	var zb bytes.Buffer
	zw := zlib.NewWriter(&zb) // the browser SDK's fflate Zlib stream (78 9c)
	_, _ = zw.Write([]byte(events))
	_ = zw.Close()
	rec := append([]byte(fmt.Sprintf(`{"segment_id":%d}`+"\n", segment)), zb.Bytes()...)
	return []string{binItem("replay_event", ev), binItem("replay_recording", rec)}
}

func gunzipBody(t *testing.T, b []byte) string {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestMuninnWireWeb(t *testing.T) {
	x := newMuninnTx(t)
	first := `[{"type":4,"timestamp":1791972000000,"data":{"href":"https://admin.example/","width":1280,"height":720}},
	  {"type":2,"timestamp":1791972000010,"data":{"node":{"type":0,"childNodes":[],"id":1},"initialOffset":{"left":0,"top":0}}},
	  {"type":5,"timestamp":1791972000020,"data":{"tag":"options","payload":{"maskAllText":true,"maskAllImages":true}}}]`
	second := `[{"type":3,"timestamp":1791972005000,"data":{"source":2,"type":2,"id":1,"x":5,"y":6}},
	  {"type":3,"timestamp":1791972009000,"data":{"source":0,"texts":[],"attributes":[],"removes":[],"adds":[]}}]`
	// No session item: a browser app without a release sends none.
	x.send(t, hdr("sentry.javascript.react"), webReplayItems(t, 0, 1791972000000, first)...)
	x.send(t, hdr("sentry.javascript.react"), webReplayItems(t, 1, 1791972005000, second)...)
	cs := x.muninnChunks(t)
	if len(cs) != 2 {
		t.Fatalf("chunks: %d", len(cs))
	}
	a0, a1 := cs[0].attrs, cs[1].attrs
	if a0["session.id"] != webReplay || a0["ouo.replay.id"] != webReplay || a0["ouo.replay.format"] != formatRRWeb ||
		a0["ouo.replay.encoding"] != "gzip" || a0["ouo.replay.keyframe"] != true || a0["ouo.replay.sequence"] != int64(0) ||
		a0["ouo.replay.segment.index"] != int64(0) || a0["ouo.replay.masked"] != true ||
		a0["ouo.replay.start_time"] != int64(1791972000000) || a0["ouo.replay.end_time"] != int64(1791972000020) {
		t.Errorf("first web chunk: %+v", a0)
	}
	if a1["ouo.replay.keyframe"] != false || a1["ouo.replay.sequence"] != int64(1) || a1["ouo.replay.segment.index"] != int64(0) ||
		a1["ouo.replay.start_time"] != int64(1791972005000) || a1["ouo.replay.end_time"] != int64(1791972009000) {
		t.Errorf("second web chunk: %+v", a1)
	}
	// The two bodies, decompressed and joined, are rrweb/2: one event per line, in order.
	nd := gunzipBody(t, cs[0].body.([]byte)) + gunzipBody(t, cs[1].body.([]byte))
	lines := strings.Split(strings.TrimSuffix(nd, "\n"), "\n")
	if len(lines) != 5 {
		t.Fatalf("ndjson lines: %d\n%s", len(lines), nd)
	}
	for i, want := range []int{4, 2, 5, 3, 3} {
		var e struct{ Type int }
		if err := json.Unmarshal([]byte(lines[i]), &e); err != nil || e.Type != want {
			t.Errorf("line %d: %s", i, lines[i])
		}
	}
}

func TestLegacyWireIgnoresWebReplay(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.javascript.react"), webReplayItems(t, 0, 1791972000000, `[{"type":2,"timestamp":1791972000000,"data":{}}]`)...)
	if n := len(x.muninnChunks(t)); n != 0 {
		t.Errorf("web replay on the legacy wire: %d chunks", n)
	}
	if n := x.legacyChunks(); n != 0 {
		t.Errorf("web replay as a legacy chunk: %d", n)
	}
}

func TestRRWebNDJSONErrors(t *testing.T) {
	for name, rec := range map[string]string{
		"not json":  "{\"segment_id\":0}\nnope",
		"no events": "{\"segment_id\":0}\n[]",
		"bad gzip":  "\x1f\x8b\x00",
	} {
		if _, _, _, _, err := rrwebNDJSON([]byte(rec)); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	// Seconds instead of milliseconds are scaled.
	_, s, e, kf, err := rrwebNDJSON([]byte("{\"segment_id\":0}\n[{\"type\":3,\"timestamp\":1791972000.5,\"data\":{}}]"))
	if err != nil || s != 1791972000500 || e != s || kf {
		t.Errorf("seconds: %d %d %v %v", s, e, kf, err)
	}
}

func TestReplayWireValidate(t *testing.T) {
	cfg := createDefaultConfig().(*Config)
	cfg.ServerConfig.NetAddr.Endpoint = "localhost:0"
	cfg.Projects = []ProjectConfig{{SentryProjectID: "1", PublicKeys: []string{"k"}, Upstream: UpstreamNone, OuoProjectID: "mobile-store", ServiceName: "s"}}
	for _, w := range []string{"", ReplayWireLegacy, ReplayWireMuninn} {
		cfg.ReplayWire = w
		if err := cfg.Validate(); err != nil {
			t.Errorf("%q: %v", w, err)
		}
	}
	cfg.ReplayWire = "rrweb"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "replay_wire") {
		t.Errorf("bad wire: %v", err)
	}
}
