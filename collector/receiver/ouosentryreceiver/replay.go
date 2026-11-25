package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.uber.org/zap"
)

// Replay chunk attributes, the ones the ouoreplay exporter reads (ADR-0007).
const (
	attrReplaySeq      = "ouo.replay.seq"
	attrReplayKind     = "ouo.replay.kind"
	attrReplayEncoding = "ouo.replay.encoding"
	// attrReplayChunk routes the record to the replay pipeline (spec section 10).
	attrReplayChunk   = "ouo.replay.chunk"
	replayServiceName = "ouo-replay"
	maxPendingReplays = 2000
)

// replayEvent is the `replay_event` part of a replay_video item.
type replayEvent struct {
	ReplayID             string      `json:"replay_id"`
	SegmentID            int         `json:"segment_id"`
	ReplayType           string      `json:"replay_type"`
	ReplayStartTimestamp flexTime    `json:"replay_start_timestamp"`
	Timestamp            flexTime    `json:"timestamp"`
	Release              string      `json:"release"`
	Environment          string      `json:"environment"`
	Platform             string      `json:"platform"`
	SDK                  *SDKInfo    `json:"sdk"`
	User                 *sentryUser `json:"user"`
	Contexts             contexts    `json:"contexts"`
}

// replaySegment is one decoded replay_video item.
type replaySegment struct {
	event       replayEvent
	video       []byte
	videoMeta   *videoPayload
	startedAt   time.Time
	touches     []touch
	received    time.Time
	os          string
	resolvedSID string
	resource    pcommon.Map // resource of the envelope, for breadcrumb records
	sdkName     string
	breadcrumbs []breadcrumb
	masked      *bool  // from the recording's `options` event (first segment of a replay)
	web         bool   // a browser recording (replay_event + replay_recording items)
	rrweb       []byte // a browser recording as rrweb/2 (one event per line, timestamps in ms)
	keyframe    bool   // the browser recording holds a full snapshot
	start, end  int64  // first and last event of a browser recording, ms
	segIndex    int    // ouo.replay.segment.index of a browser segment
}

type videoPayload struct {
	SegmentID     int    `json:"segmentId"`
	Size          int64  `json:"size"`
	Duration      int64  `json:"duration"`
	Encoding      string `json:"encoding"`
	Container     string `json:"container"`
	Height        int    `json:"height"`
	Width         int    `json:"width"`
	FrameCount    int    `json:"frameCount"`
	FrameRate     int    `json:"frameRate"`
	FrameRateType string `json:"frameRateType"`
	Left          int    `json:"left"`
	Top           int    `json:"top"`
}

type touch struct {
	TS    int64   `json:"ts"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Phase string  `json:"phase"`
}

// decodeReplayVideo decodes the msgpack map {replay_event, replay_recording,
// replay_video} (sentry-java SentryEnvelopeItem.fromReplay; spec section 9).
func decodeReplayVideo(payload []byte) (*replaySegment, error) {
	m, err := decodeMsgpackMap(payload)
	if err != nil {
		return nil, err
	}
	seg := &replaySegment{}
	ev, ok := m["replay_event"]
	if !ok {
		return nil, errors.New("replay_video item without replay_event")
	}
	if err := json.Unmarshal(ev, &seg.event); err != nil {
		return nil, fmt.Errorf("replay_event: %w", err)
	}
	if seg.event.ReplayID == "" {
		return nil, errors.New("replay_event without replay_id")
	}
	seg.video = m["replay_video"]
	if rec, ok := m["replay_recording"]; ok {
		if err := seg.parseRecording(rec); err != nil {
			return nil, fmt.Errorf("replay_recording: %w", err)
		}
	}
	return seg, nil
}

// recordingEvents returns the JSON event array of a recording,
// `{"segment_id":n}\n[events]` with either part optionally compressed.
func recordingEvents(rec []byte) ([]byte, error) {
	rec, err := gunzipIf(rec)
	if err != nil {
		return nil, err
	}
	_, body, found := bytes.Cut(rec, []byte("\n"))
	if !found {
		body = rec
	}
	return gunzipIf(bytes.TrimSpace(body))
}

// parseRecording reads a recording and extracts the video event, the touches,
// the breadcrumbs and the masking options.
func (seg *replaySegment) parseRecording(rec []byte) error {
	body, err := recordingEvents(rec)
	if err != nil {
		return err
	}
	return seg.parseEvents(body)
}

func (seg *replaySegment) parseEvents(body []byte) error {
	var events []struct {
		Type      int             `json:"type"`
		Timestamp float64         `json:"timestamp"`
		Data      json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &events); err != nil {
		return err
	}
	for _, e := range events {
		ts := int64(e.Timestamp)
		if e.Timestamp > 0 && e.Timestamp < 1e11 { // seconds, not milliseconds
			ts = int64(e.Timestamp * 1000)
		}
		switch e.Type {
		case 5: // custom
			var d struct {
				Tag     string          `json:"tag"`
				Payload json.RawMessage `json:"payload"`
			}
			if json.Unmarshal(e.Data, &d) != nil {
				continue
			}
			switch d.Tag {
			case "breadcrumb":
				var b breadcrumb
				if json.Unmarshal(d.Payload, &b) == nil {
					b.at = time.UnixMilli(ts).UTC()
					seg.breadcrumbs = append(seg.breadcrumbs, b)
				}
				continue
			case "options":
				var o struct {
					MaskAllText   *bool `json:"maskAllText"`
					MaskAllImages *bool `json:"maskAllImages"` // mobile
					MaskAllInputs *bool `json:"maskAllInputs"` // browser
					BlockAllMedia *bool `json:"blockAllMedia"` // browser
				}
				if json.Unmarshal(d.Payload, &o) != nil || o.MaskAllText == nil {
					continue
				}
				var m bool
				switch {
				case o.MaskAllImages != nil:
					m = *o.MaskAllText || *o.MaskAllImages
				case o.BlockAllMedia != nil:
					m = *o.MaskAllText || *o.BlockAllMedia || (o.MaskAllInputs != nil && *o.MaskAllInputs)
				default:
					continue
				}
				seg.masked = &m
				continue
			case "video":
			default:
				continue
			}
			var vp videoPayload
			if json.Unmarshal(d.Payload, &vp) == nil {
				seg.videoMeta = &vp
				seg.startedAt = time.UnixMilli(ts).UTC()
			}
		case 3: // incremental snapshot
			var d struct {
				Source    int      `json:"source"`
				Type      int      `json:"type"`
				X         *float64 `json:"x"`
				Y         *float64 `json:"y"`
				Positions []struct {
					X          float64 `json:"x"`
					Y          float64 `json:"y"`
					TimeOffset float64 `json:"timeOffset"`
				} `json:"positions"`
			}
			if json.Unmarshal(e.Data, &d) != nil {
				continue
			}
			switch d.Source {
			case 2: // mouse interaction: TouchStart 7, TouchMove_Departed 8, TouchEnd 9, TouchCancel 10
				phase := map[int]string{7: "began", 8: "moved", 9: "ended", 10: "ended"}[d.Type]
				if phase == "" || d.X == nil || d.Y == nil {
					continue
				}
				seg.touches = append(seg.touches, touch{TS: ts, X: *d.X, Y: *d.Y, Phase: phase})
			case 6: // touch move: positions with timeOffset (ms, negative = before the event)
				for _, p := range d.Positions {
					seg.touches = append(seg.touches, touch{TS: ts + int64(p.TimeOffset), X: p.X, Y: p.Y, Phase: "moved"})
				}
			}
		}
	}
	return nil
}

// videoChunk is the `kind: "video"` replay chunk (spec section 9 "Output").
type videoChunk struct {
	Kind          string   `json:"kind"`
	SchemaVersion int      `json:"schema_version"`
	SessionID     string   `json:"session_id"`
	Seq           int      `json:"seq"`
	StartedAt     int64    `json:"started_at"`
	EndedAt       int64    `json:"ended_at"`
	Viewport      viewport `json:"viewport"`
	Platform      string   `json:"platform,omitempty"`
	Video         struct {
		Container  string `json:"container"`
		Encoding   string `json:"encoding"`
		DurationMS int64  `json:"duration_ms"`
		FrameCount int    `json:"frame_count"`
		FrameRate  int    `json:"frame_rate"`
		MP4        string `json:"mp4"`
	} `json:"video"`
	Touches []touch `json:"touches"`
	Source  struct {
		Vendor     string `json:"vendor"`
		ReplayID   string `json:"replay_id"`
		SegmentID  int    `json:"segment_id"`
		ReplayType string `json:"replay_type,omitempty"`
	} `json:"source"`
	Masked bool `json:"masked"`
}

type viewport struct {
	Width  int     `json:"width"`
	Height int     `json:"height"`
	Scale  float64 `json:"scale"`
}

// pendingReplays holds segments whose session is not known yet.
type pendingReplays struct {
	mu   sync.Mutex
	segs map[string][]pendingSeg // project/replay_id
	n    int
}

type pendingSeg struct {
	j     job
	seg   *replaySegment
	until time.Time
}

// handleReplay resolves the session of a segment and emits it, or holds it.
func (r *sentryReceiver) handleReplay(ctx context.Context, j job, seg *replaySegment) {
	if !seg.web && (seg.videoMeta == nil || len(seg.video) < 8) {
		r.drop(ctx, j.project.OuoProjectID, "replay_incomplete")
		return
	}
	sid, ok := r.resolveReplay(j, seg)
	if seg.web {
		// A browser app that sends no session (no release set, or sessions
		// off) still records: its replay id stands for the session. A browser
		// replay outlives Sentry's sessions (one per page load or route), so it
		// keeps the session its first segment got: one replay, one session.id.
		if !ok || sid == "" {
			sid = seg.event.ReplayID
		}
		r.emitReplay(ctx, j, seg, r.webReplays.note(j.project.OuoProjectID, seg, sid))
		return
	}
	if !ok {
		r.holdReplay(ctx, j, seg)
		return
	}
	if sid == "" {
		r.drop(ctx, j.project.OuoProjectID, "replay_conflict")
		return
	}
	r.emitReplay(ctx, j, seg, sid)
}

// resolveReplay returns the session id of a segment: through the learned
// replay id, else through the device (rule 3). ok=false when unknown yet;
// sid="" with ok=true when the session already holds another replay.
func (r *sentryReceiver) resolveReplay(j job, seg *replaySegment) (string, bool) {
	var sid string
	var found bool
	r.state.withLock(func() {
		st := r.state
		project := j.project.OuoProjectID
		x := st.byReplayID(project, seg.event.ReplayID)
		if x == nil && seg.event.User != nil {
			at := firstTime(seg.startedAt, seg.event.Timestamp.Time)
			if c := st.byDeviceForReplay(project, string(seg.event.User.ID), at); c != nil {
				x = c
				st.learnReplay(c, seg.event.ReplayID)
			}
		}
		if x == nil {
			return
		}
		found = true
		if x.replayID != "" && x.replayID != seg.event.ReplayID {
			return // one session, one replay (ADR-0003)
		}
		x.replayID = seg.event.ReplayID
		sid = x.sid
		// Only the first segment carries the masking options; later ones
		// inherit them from the session.
		if seg.masked != nil {
			x.replayMasked = seg.masked
		} else {
			seg.masked = x.replayMasked
		}
	})
	return sid, found
}

func (r *sentryReceiver) holdReplay(ctx context.Context, j job, seg *replaySegment) {
	hold := r.cfg.State.ReplayHold
	if hold <= 0 {
		hold = 10 * time.Minute
	}
	p := &r.pending
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.segs == nil {
		p.segs = map[string][]pendingSeg{}
	}
	if p.n >= maxPendingReplays {
		r.drop(ctx, j.project.OuoProjectID, "replay_unresolved")
		return
	}
	k := j.project.OuoProjectID + "/" + seg.event.ReplayID
	p.segs[k] = append(p.segs[k], pendingSeg{j: j, seg: seg, until: time.Now().Add(hold)})
	p.n++
}

// flushPending retries held segments after the state changed, and drops
// expired ones.
func (r *sentryReceiver) flushPending(ctx context.Context) {
	p := &r.pending
	p.mu.Lock()
	var ready []pendingSeg
	now := time.Now()
	for k, list := range p.segs {
		var keep []pendingSeg
		for _, ps := range list {
			sid, ok := r.resolveReplay(ps.j, ps.seg)
			switch {
			case ok && sid != "":
				ps.seg.resolvedSID = sid
				ready = append(ready, ps)
			case ok:
				r.drop(ctx, ps.j.project.OuoProjectID, "replay_conflict")
			case now.After(ps.until):
				r.drop(ctx, ps.j.project.OuoProjectID, "replay_unresolved")
			default:
				keep = append(keep, ps)
				continue
			}
			p.n--
		}
		if len(keep) == 0 {
			delete(p.segs, k)
		} else {
			p.segs[k] = keep
		}
	}
	p.mu.Unlock()
	for _, ps := range ready {
		r.emitReplay(ctx, ps.j, ps.seg, ps.seg.resolvedSID)
	}
}

// emitReplay builds the video chunk and sends it as one log record.
func (r *sentryReceiver) emitReplay(ctx context.Context, j job, seg *replaySegment, sid string) {
	if r.muninnWire() {
		if r.emitReplayMuninn(ctx, j, seg, sid) {
			r.emitBreadcrumbs(ctx, j, seg, sid)
		}
		return
	}
	logsNext, _ := r.consumers()
	if logsNext == nil {
		return
	}
	vm := seg.videoMeta
	// Unknown masking options count as masked (the SDK default).
	masked := seg.masked == nil || *seg.masked
	c := videoChunk{Kind: "video", SchemaVersion: 1, SessionID: sid, Seq: seg.event.SegmentID, Masked: masked}
	start := seg.startedAt
	if start.IsZero() {
		start = seg.event.Timestamp.Time
	}
	c.StartedAt = start.UnixMilli()
	c.EndedAt = c.StartedAt + vm.Duration
	c.Viewport = viewport{Width: vm.Width, Height: vm.Height, Scale: 1}
	c.Platform = seg.os
	if c.Platform == "" {
		osName := ""
		if seg.event.Contexts.OS != nil {
			osName = seg.event.Contexts.OS.Name
		}
		c.Platform = detectOS("", osName, seg.event.Platform)
	}
	c.Video.Container = firstString(vm.Container, "mp4")
	c.Video.Encoding = firstString(vm.Encoding, "h264")
	c.Video.DurationMS = vm.Duration
	c.Video.FrameCount = vm.FrameCount
	c.Video.FrameRate = vm.FrameRate
	c.Video.MP4 = base64.StdEncoding.EncodeToString(seg.video)
	c.Touches = seg.touches
	if c.Touches == nil {
		c.Touches = []touch{}
	}
	c.Source.Vendor = "sentry"
	c.Source.ReplayID = seg.event.ReplayID
	c.Source.SegmentID = seg.event.SegmentID
	c.Source.ReplayType = seg.event.ReplayType
	body, err := json.Marshal(c)
	if err != nil {
		r.drop(ctx, j.project.OuoProjectID, "replay_encode")
		return
	}

	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", replayServiceName)
	rl.Resource().Attributes().PutStr(attrProjectID, j.project.OuoProjectID)
	sl := rl.ScopeLogs().AppendEmpty()
	sl.Scope().SetName(scopeName)
	lr := sl.LogRecords().AppendEmpty()
	lr.SetTimestamp(pcommon.NewTimestampFromTime(start))
	lr.SetObservedTimestamp(pcommon.NewTimestampFromTime(j.receivedAt))
	lr.Body().SetEmptyBytes().FromRaw(body)
	a := lr.Attributes()
	a.PutStr(attrProjectID, j.project.OuoProjectID)
	a.PutStr(attrSessionID, sid)
	a.PutInt(attrReplaySeq, int64(c.Seq))
	a.PutStr(attrReplayKind, "video")
	a.PutStr(attrReplayEncoding, "json")
	a.PutBool(attrReplayChunk, true)

	if err := logsNext.ConsumeLogs(client.NewContext(ctx, j.clientInfo()), ld); err != nil {
		r.drop(ctx, j.project.OuoProjectID, "consumer_replay")
		r.set.Logger.Debug("replay chunk rejected by the pipeline", zap.Error(err))
	}
	r.emitBreadcrumbs(ctx, j, seg, sid)
}

// ---- msgpack subset ------------------------------------------------------------

// decodeMsgpackMap decodes a top-level msgpack map with string keys and
// binary (or string) values: exactly what the Sentry SDKs write for
// replay_video. Anything else is an error.
func decodeMsgpackMap(b []byte) (map[string][]byte, error) {
	d := &mpDecoder{b: b}
	n, err := d.mapLen()
	if err != nil {
		return nil, err
	}
	// Every entry needs at least two bytes (empty key and empty value); a
	// header claiming more entries than that is hostile or truncated.
	if n > (len(b)-d.pos)/2 {
		return nil, errMsgpack
	}
	out := make(map[string][]byte, n)
	for range n {
		k, err := d.bytesOrString()
		if err != nil {
			return nil, fmt.Errorf("msgpack key: %w", err)
		}
		v, err := d.bytesOrString()
		if err != nil {
			return nil, fmt.Errorf("msgpack value of %q: %w", k, err)
		}
		out[string(k)] = v
	}
	return out, nil
}

type mpDecoder struct {
	b   []byte
	pos int
}

var errMsgpack = errors.New("unsupported or truncated msgpack")

func (d *mpDecoder) take(n int) ([]byte, error) {
	if n < 0 || d.pos+n > len(d.b) {
		return nil, errMsgpack
	}
	v := d.b[d.pos : d.pos+n]
	d.pos += n
	return v, nil
}

func (d *mpDecoder) uint(n int) (int, error) {
	v, err := d.take(n)
	if err != nil {
		return 0, err
	}
	switch n {
	case 1:
		return int(v[0]), nil
	case 2:
		return int(binary.BigEndian.Uint16(v)), nil
	default:
		u := binary.BigEndian.Uint32(v)
		if u > 1<<31-1 {
			return 0, errMsgpack
		}
		return int(u), nil
	}
}

func (d *mpDecoder) mapLen() (int, error) {
	t, err := d.take(1)
	if err != nil {
		return 0, err
	}
	switch c := t[0]; {
	case c >= 0x80 && c <= 0x8f:
		return int(c & 0x0f), nil
	case c == 0xde:
		return d.uint(2)
	case c == 0xdf:
		return d.uint(4)
	}
	return 0, errMsgpack
}

func (d *mpDecoder) bytesOrString() ([]byte, error) {
	t, err := d.take(1)
	if err != nil {
		return nil, err
	}
	var n int
	switch c := t[0]; {
	case c >= 0xa0 && c <= 0xbf:
		n = int(c & 0x1f)
	case c == 0xd9 || c == 0xc4:
		n, err = d.uint(1)
	case c == 0xda || c == 0xc5:
		n, err = d.uint(2)
	case c == 0xdb || c == 0xc6:
		n, err = d.uint(4)
	default:
		return nil, errMsgpack
	}
	if err != nil {
		return nil, err
	}
	return d.take(n)
}
