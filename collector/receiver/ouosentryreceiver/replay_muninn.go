package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.uber.org/zap"
)

// Replay wires (Config.ReplayWire, spec section 9d).
const (
	ReplayWireLegacy = "legacy"
	ReplayWireMuninn = "muninn"
)

// The replay contract Muninn stores (docs/specs/muninn.md section 3.1).
const (
	replayScope       = "ouo.replay"
	eventReplayChunk  = "ouo.replay.chunk"
	formatRRWeb       = "rrweb/2"
	formatVideo       = "ouo-video/1"
	maxReplayChunk    = 1 << 20 // Muninn's hard limit per chunk body
	maxRecordingBytes = 64 << 20
	maxWebReplays     = 50000
)

func (r *sentryReceiver) muninnWire() bool { return r.cfg.ReplayWire == ReplayWireMuninn }

// decodeWebReplay pairs a browser envelope's `replay_event` and
// `replay_recording` items into one segment (spec section 9d) and converts the
// recording to rrweb/2.
func decodeWebReplay(event, recording []byte) (*replaySegment, error) {
	seg := &replaySegment{web: true}
	if err := json.Unmarshal(event, &seg.event); err != nil {
		return nil, err
	}
	if seg.event.ReplayID == "" {
		return nil, errors.New("replay_event without replay_id")
	}
	events, err := recordingEvents(recording)
	if err != nil {
		return nil, err
	}
	if err := seg.parseEvents(events); err != nil {
		return nil, err
	}
	if seg.rrweb, seg.start, seg.end, seg.keyframe, err = rrwebNDJSON(events); err != nil {
		return nil, err
	}
	return seg, nil
}

// rrwebNDJSON turns the event array of a Sentry browser recording into rrweb/2:
// one compact rrweb event per line. Sentry writes some of its custom events
// (performanceSpan, ui.focus, ui.blur, replay.mutations, replay.throttled) with
// the timestamp in seconds; rrweb players sort by timestamp, so these are
// rewritten in milliseconds. It returns the time range of the events and
// whether they hold a full snapshot (rrweb type 2), which makes the chunk a
// keyframe.
func rrwebNDJSON(events []byte) (out []byte, start, end int64, keyframe bool, err error) {
	var raws []json.RawMessage
	if err = json.Unmarshal(events, &raws); err != nil {
		return nil, 0, 0, false, err
	}
	var buf bytes.Buffer
	for _, raw := range raws {
		var e struct {
			Type      int     `json:"type"`
			Timestamp float64 `json:"timestamp"`
		}
		if json.Unmarshal(raw, &e) != nil {
			continue
		}
		ts := int64(e.Timestamp)
		if e.Timestamp > 0 && e.Timestamp < 1e11 { // seconds, not milliseconds
			ts = int64(e.Timestamp * 1000)
			var m map[string]json.RawMessage
			if json.Unmarshal(raw, &m) != nil {
				continue
			}
			m["timestamp"] = json.RawMessage(strconv.FormatInt(ts, 10))
			if raw, err = json.Marshal(m); err != nil {
				return nil, 0, 0, false, err
			}
		}
		if json.Compact(&buf, raw) != nil {
			continue
		}
		buf.WriteByte('\n')
		if ts > 0 && (start == 0 || ts < start) {
			start = ts
		}
		if ts > end {
			end = ts
		}
		if e.Type == 2 {
			keyframe = true
		}
	}
	if buf.Len() == 0 {
		return nil, 0, 0, false, errors.New("recording without events")
	}
	return buf.Bytes(), start, end, keyframe, nil
}

// gunzipIf inflates a gzip (1f 8b) or zlib (78 xx) stream and returns other
// bytes unchanged. The browser SDK compresses its recording with zlib
// (fflate's Zlib, 78 9c); the mobile SDKs send gzip or plain JSON.
func gunzipIf(b []byte) ([]byte, error) {
	var zr io.Reader
	switch {
	case len(b) >= 2 && b[0] == 0x1f && b[1] == 0x8b:
		gr, err := gzip.NewReader(bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		zr = gr
	case len(b) >= 2 && b[0] == 0x78 && (uint16(b[0])<<8|uint16(b[1]))%31 == 0:
		zl, err := zlib.NewReader(bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		zr = zl
	default:
		return b, nil
	}
	return io.ReadAll(io.LimitReader(zr, maxRecordingBytes))
}

// videoHeader is the JSON line before the mp4 of an ouo-video/1 body
// (docs/specs/mobile-replay.md, "ouo-video/1").
type videoHeader struct {
	T       int64        `json:"t"`
	Type    string       `json:"type"`
	End     int64        `json:"end"`
	W       int          `json:"w"`
	H       int          `json:"h"`
	Scale   float64      `json:"scale"`
	FPS     int          `json:"fps"`
	Frames  int          `json:"frames"`
	MP4     int          `json:"mp4"`
	Touches []videoTouch `json:"touches"`
}

type videoTouch struct {
	T     int64   `json:"t"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Phase string  `json:"phase"`
}

// webReplays remembers, per browser replay, what later segments need: the
// session.id its first segment got, the sequence of its last keyframe, and its
// masking (only the first segment carries the options event).
type webReplays struct {
	mu sync.Mutex
	m  map[string]*webReplayState
}

type webReplayState struct {
	sid      string
	keyframe int // sequence of the last keyframe, -1 before the first
	masked   *bool
}

// note records a browser segment and returns the session.id to send it under.
// It sets the segment's keyframe index and masking.
func (x *webReplays) note(project string, seg *replaySegment, sid string) string {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.m == nil || len(x.m) >= maxWebReplays {
		x.m = map[string]*webReplayState{}
	}
	k := project + "/" + seg.event.ReplayID
	w := x.m[k]
	if w == nil {
		w = &webReplayState{sid: sid, keyframe: -1}
		x.m[k] = w
	}
	seq := seg.event.SegmentID
	switch {
	case seg.keyframe:
		w.keyframe = seq
		seg.segIndex = seq
	case w.keyframe >= 0 && w.keyframe <= seq:
		seg.segIndex = w.keyframe
	}
	if seg.masked != nil {
		w.masked = seg.masked
	} else {
		seg.masked = w.masked
	}
	return w.sid
}

// hex32 writes an id the way Muninn checks it: 32 lowercase hex characters.
func hex32(s string) string { return strings.ToLower(strings.ReplaceAll(s, "-", "")) }

// emitReplayMuninn sends one segment as an ouo.replay.chunk record (Muninn
// spec section 3.1): rrweb/2 for a browser recording, ouo-video/1 for a
// mobile video segment. Sentry's replay id is the replay and the stream id
// (one recording, one tab or app process), its segment_id the sequence.
func (r *sentryReceiver) emitReplayMuninn(ctx context.Context, j job, seg *replaySegment, sid string) bool {
	logsNext, _ := r.consumers()
	if logsNext == nil {
		return false
	}
	project := j.project.OuoProjectID
	replayID := hex32(seg.event.ReplayID)
	seq := seg.event.SegmentID
	var (
		body        []byte
		format, enc string
		keyframe    bool
		start, end  int64
		segIndex    = seq
		masked      = seg.masked == nil || *seg.masked // unknown options: the SDK default
	)
	if seg.web {
		var gz bytes.Buffer
		zw := gzip.NewWriter(&gz)
		_, _ = zw.Write(seg.rrweb)
		_ = zw.Close()
		body, format, enc, keyframe, start, end = gz.Bytes(), formatRRWeb, "gzip", seg.keyframe, seg.start, seg.end
		segIndex = seg.segIndex
		if start == 0 {
			start = seg.event.Timestamp.Time.UnixMilli()
		}
	} else {
		vm := seg.videoMeta
		at := seg.startedAt
		if at.IsZero() {
			at = seg.event.Timestamp.Time
		}
		h := videoHeader{
			T: at.UnixMilli(), Type: "video", End: at.UnixMilli() + vm.Duration,
			W: vm.Width, H: vm.Height, Scale: 1, FPS: vm.FrameRate, Frames: vm.FrameCount,
			MP4: len(seg.video), Touches: []videoTouch{},
		}
		for _, t := range seg.touches {
			h.Touches = append(h.Touches, videoTouch{T: t.TS, X: t.X, Y: t.Y, Phase: t.Phase})
		}
		hb, err := json.Marshal(h)
		if err != nil {
			r.drop(ctx, project, "replay_encode")
			return false
		}
		body = make([]byte, 0, len(hb)+1+len(seg.video))
		body = append(append(append(body, hb...), '\n'), seg.video...)
		format, enc, keyframe, start, end = formatVideo, "identity", true, h.T, h.End
	}
	if end < start {
		end = start
	}
	if len(body) > maxReplayChunk {
		r.drop(ctx, project, "replay_too_large")
		return false
	}
	sum := sha256.Sum256(body)

	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", firstString(j.project.ServiceName, replayServiceName))
	rl.Resource().Attributes().PutStr(attrProjectID, project)
	sl := rl.ScopeLogs().AppendEmpty()
	sl.Scope().SetName(replayScope)
	lr := sl.LogRecords().AppendEmpty()
	lr.SetEventName(eventReplayChunk)
	lr.SetTimestamp(pcommon.Timestamp(start * 1e6))
	lr.SetObservedTimestamp(pcommon.NewTimestampFromTime(j.receivedAt))
	lr.Body().SetEmptyBytes().FromRaw(body)
	a := lr.Attributes()
	a.PutStr(attrSessionID, hex32(sid))
	a.PutStr("ouo.replay.id", replayID)
	a.PutStr("ouo.replay.stream.id", replayID)
	a.PutInt("ouo.replay.sequence", int64(seq))
	a.PutInt("ouo.replay.segment.index", int64(segIndex))
	a.PutBool("ouo.replay.keyframe", keyframe)
	a.PutInt("ouo.replay.start_time", start)
	a.PutInt("ouo.replay.end_time", end)
	a.PutStr("ouo.replay.format", format)
	a.PutStr("ouo.replay.encoding", enc)
	a.PutStr("ouo.replay.sha256", hex.EncodeToString(sum[:]))
	a.PutInt("ouo.replay.byte_size", int64(len(body)))
	a.PutBool("ouo.replay.masked", masked)
	if seg.event.ReplayType == "buffer" {
		a.PutStr("ouo.replay.mode", "buffer")
		a.PutStr("ouo.replay.trigger", "error")
	} else {
		a.PutStr("ouo.replay.mode", "session")
	}
	a.PutStr("ouo.replay.source.vendor", "sentry")
	a.PutStr("ouo.replay.source.id", replayID)
	// Routes the record to the bridge's replay pipeline (spec section 10).
	a.PutBool(attrReplayChunk, true)

	if err := logsNext.ConsumeLogs(client.NewContext(ctx, j.clientInfo()), ld); err != nil {
		r.drop(ctx, project, "consumer_replay")
		r.set.Logger.Debug("replay chunk rejected by the pipeline", zap.Error(err))
		return false
	}
	return true
}
