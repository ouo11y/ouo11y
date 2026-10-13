package replay

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// Allowed touch phases of a frames chunk (docs/specs/mobile-replay.md).
var touchPhases = map[string]bool{"began": true, "moved": true, "ended": true}

// jpegMagic is the SOI marker every JPEG starts with.
var jpegMagic = []byte{0xFF, 0xD8}

// frameCount of a frames chunk may be at most this many (spec: flushed at 10;
// generous headroom for touch-coalesced captures).
const maxFramesPerChunk = 1000

// parseChunk validates the envelope of any kind and counts events / frames /
// touches without keeping them. Unknown keys are tolerated. For a video
// chunk it also decodes the mp4 (at most maxVideoBytes, ErrTooLarge above)
// and builds the JSON to store (see spliceVideo).
func parseChunk(body []byte, maxVideoBytes int64) (Chunk, error) {
	var c Chunk
	dec := json.NewDecoder(bytes.NewReader(body))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return c, fmt.Errorf("%w: body must be a JSON object", ErrInvalid)
	}
	var (
		seenEvents, seenFrames, seenTouches, seenViewport bool
		schemaVersion                                     *int
		kindSet                                           bool
		touchesBefore                                     int
		decodeBuf                                         []byte
		// video: the raw value and its span in body (end of the key string
		// to end of the value) so the stored JSON can replace it in place.
		videoRaw, sourceRaw      json.RawMessage
		videoKeyEnd, videoValEnd int64
	)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return c, fmt.Errorf("%w: %v", ErrInvalid, err)
		}
		key, _ := keyTok.(string)
		switch key {
		case "kind":
			kindSet = true
			if err := dec.Decode(&c.Kind); err != nil {
				return c, fmt.Errorf("%w: kind: %v", ErrInvalid, err)
			}
		case "schema_version":
			var v int
			if err := dec.Decode(&v); err != nil {
				return c, fmt.Errorf("%w: schema_version: %v", ErrInvalid, err)
			}
			schemaVersion = &v
		case "session_id":
			if err := dec.Decode(&c.SessionID); err != nil {
				return c, fmt.Errorf("%w: session_id: %v", ErrInvalid, err)
			}
		case "seq":
			if err := dec.Decode(&c.Seq); err != nil {
				return c, fmt.Errorf("%w: seq: %v", ErrInvalid, err)
			}
		case "started_at":
			if err := dec.Decode(&c.StartedAt); err != nil {
				return c, fmt.Errorf("%w: started_at: %v", ErrInvalid, err)
			}
		case "ended_at":
			if err := dec.Decode(&c.EndedAt); err != nil {
				return c, fmt.Errorf("%w: ended_at: %v", ErrInvalid, err)
			}
		case "platform":
			if err := dec.Decode(&c.Platform); err != nil {
				return c, fmt.Errorf("%w: platform: %v", ErrInvalid, err)
			}
		case "viewport":
			seenViewport = true
			var vp Viewport
			if err := dec.Decode(&vp); err != nil {
				return c, fmt.Errorf("%w: viewport: %v", ErrInvalid, err)
			}
			c.Viewport = &vp
		case "events":
			seenEvents = true
			n, err := countArray(dec, "events", func(raw json.RawMessage, i int) error { return nil })
			if err != nil {
				return c, err
			}
			c.EventCount = n
		case "frames":
			seenFrames = true
			n, err := countArray(dec, "frames", func(raw json.RawMessage, i int) error {
				var err error
				decodeBuf, err = validateFrame(raw, i, decodeBuf)
				return err
			})
			if err != nil {
				return c, err
			}
			if n > maxFramesPerChunk {
				return c, fmt.Errorf("%w: frames: at most %d per chunk", ErrInvalid, maxFramesPerChunk)
			}
			c.FrameCount = n
		case "video":
			if videoRaw != nil {
				return c, fmt.Errorf("%w: video given twice", ErrInvalid)
			}
			videoKeyEnd = dec.InputOffset()
			if err := dec.Decode(&videoRaw); err != nil {
				return c, fmt.Errorf("%w: video: %v", ErrInvalid, err)
			}
			videoValEnd = dec.InputOffset()
		case "source":
			if err := dec.Decode(&sourceRaw); err != nil {
				return c, fmt.Errorf("%w: source: %v", ErrInvalid, err)
			}
		case "touches":
			seenTouches = true
			n, err := countArray(dec, "touches", validateTouch)
			if err != nil {
				return c, err
			}
			touchesBefore = n
		default:
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return c, fmt.Errorf("%w: %s: %v", ErrInvalid, key, err)
			}
		}
	}
	if _, err := dec.Token(); err != nil {
		return c, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if !ValidSessionID(c.SessionID) {
		return c, fmt.Errorf("%w: session_id must match %s", ErrInvalid, sessionIDRe)
	}
	if c.Seq < 0 || c.Seq > 999999 {
		return c, fmt.Errorf("%w: seq must be between 0 and 999999", ErrInvalid)
	}
	if !kindSet {
		c.Kind = KindRRWeb
	}
	switch c.Kind {
	case KindRRWeb:
		if !seenEvents {
			return c, fmt.Errorf("%w: events missing", ErrInvalid)
		}
		// rrweb chunks never carry frames metadata.
		c.Viewport, c.Platform = nil, ""
		if c.EndedAt < c.StartedAt {
			c.EndedAt = c.StartedAt
		}
	case KindFrames, KindVideo:
		if schemaVersion == nil {
			return c, fmt.Errorf("%w: schema_version missing", ErrInvalid)
		}
		if *schemaVersion != 1 {
			return c, fmt.Errorf("%w: schema_version %d not supported", ErrInvalid, *schemaVersion)
		}
		if c.StartedAt <= 0 {
			return c, fmt.Errorf("%w: started_at must be epoch milliseconds", ErrInvalid)
		}
		if c.EndedAt < c.StartedAt {
			return c, fmt.Errorf("%w: ended_at must not be before started_at", ErrInvalid)
		}
		if !seenViewport {
			return c, fmt.Errorf("%w: viewport missing", ErrInvalid)
		}
		if c.Viewport.Width <= 0 || c.Viewport.Height <= 0 {
			return c, fmt.Errorf("%w: viewport width and height must be positive", ErrInvalid)
		}
		if c.Viewport.Scale == 0 {
			c.Viewport.Scale = 1
		}
		if c.Viewport.Scale < 0 {
			return c, fmt.Errorf("%w: viewport scale must be positive", ErrInvalid)
		}
		if seenTouches {
			c.TouchCount = touchesBefore
		}
		if c.Kind == KindFrames {
			if !seenFrames {
				return c, fmt.Errorf("%w: frames missing", ErrInvalid)
			}
			break
		}
		if err := parseVideo(&c, body, videoRaw, videoKeyEnd, videoValEnd, maxVideoBytes); err != nil {
			return c, err
		}
		if err := parseSource(&c, sourceRaw); err != nil {
			return c, err
		}
	default:
		return c, fmt.Errorf("%w: kind must be %q, %q or %q", ErrInvalid, KindRRWeb, KindFrames, KindVideo)
	}
	return c, nil
}

// mp4Brand is the box type every ISO BMFF (mp4) file starts with, at byte
// offset 4 after the 32-bit box size.
var mp4Brand = []byte("ftyp")

// parseVideo validates the `video` object of a video chunk, decodes its mp4
// and sets FrameCount, DurationMs, VideoBytes, mp4 and stored on c. Fields:
// container "mp4" (required), mp4 base64 (required, padded or unpadded,
// `ftyp` at offset 4, at most maxBytes decoded), encoding (string),
// duration_ms and frame_count (non-negative integers), frame_rate (number);
// all but container and mp4 are optional. Unknown fields are kept.
func parseVideo(c *Chunk, body []byte, raw json.RawMessage, keyEnd, valEnd int64, maxBytes int64) error {
	if raw == nil {
		return fmt.Errorf("%w: video missing", ErrInvalid)
	}
	var v map[string]json.RawMessage
	if err := json.Unmarshal(raw, &v); err != nil || v == nil {
		return fmt.Errorf("%w: video must be an object", ErrInvalid)
	}
	var container string
	if err := field(v, "container", &container); err != nil {
		return err
	}
	if container != "mp4" {
		return fmt.Errorf("%w: video.container must be \"mp4\"", ErrInvalid)
	}
	var encoding string
	if err := field(v, "encoding", &encoding); err != nil {
		return err
	}
	var frameRate float64
	if err := field(v, "frame_rate", &frameRate); err != nil {
		return err
	}
	var durationMs *int64
	if err := field(v, "duration_ms", &durationMs); err != nil {
		return err
	}
	var frameCount *int
	if err := field(v, "frame_count", &frameCount); err != nil {
		return err
	}
	if durationMs != nil && *durationMs < 0 {
		return fmt.Errorf("%w: video.duration_ms must not be negative", ErrInvalid)
	}
	if frameCount != nil && *frameCount < 0 {
		return fmt.Errorf("%w: video.frame_count must not be negative", ErrInvalid)
	}
	var b64 string
	if err := field(v, "mp4", &b64); err != nil {
		return err
	}
	if b64 == "" {
		return fmt.Errorf("%w: video.mp4 must be non-empty base64", ErrInvalid)
	}
	enc := base64.StdEncoding
	if len(b64)%4 != 0 {
		enc = base64.RawStdEncoding
	}
	// DecodedLen overestimates by at most 2 (padding): reject early without
	// decoding when even the smallest possible result is above the limit.
	if int64(enc.DecodedLen(len(b64)))-2 > maxBytes {
		return fmt.Errorf("%w: video.mp4 larger than %d bytes", ErrTooLarge, maxBytes)
	}
	mp4 := make([]byte, enc.DecodedLen(len(b64)))
	n, err := enc.Decode(mp4, []byte(b64))
	if err != nil {
		return fmt.Errorf("%w: video.mp4 is not valid base64: %v", ErrInvalid, err)
	}
	mp4 = mp4[:n]
	if int64(n) > maxBytes {
		return fmt.Errorf("%w: video.mp4 larger than %d bytes", ErrTooLarge, maxBytes)
	}
	if n < 8 || !bytes.Equal(mp4[4:8], mp4Brand) {
		return fmt.Errorf("%w: video.mp4 is not an mp4 (no ftyp box at offset 4)", ErrInvalid)
	}

	if frameCount != nil {
		c.FrameCount = *frameCount
	} else {
		c.FrameCount = 0
	}
	if durationMs != nil {
		c.DurationMs = *durationMs
	} else {
		c.DurationMs = c.EndedAt - c.StartedAt
	}
	c.VideoBytes = int64(n)
	c.mp4 = mp4

	delete(v, "mp4")
	v["bytes"] = json.RawMessage(fmt.Sprint(n))
	video, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.stored = spliceVideo(body, keyEnd, valEnd, video)
	return nil
}

// spliceVideo returns body with the value of the `video` key (the bytes
// between the end of the key string and the end of the value, i.e. the
// colon, whitespace and the value) replaced by `:` + video. Every other byte
// of the chunk is kept as uploaded.
func spliceVideo(body []byte, keyEnd, valEnd int64, video []byte) []byte {
	out := make([]byte, 0, int64(len(body))-(valEnd-keyEnd)+int64(len(video))+1)
	out = append(out, body[:keyEnd]...)
	out = append(out, ':')
	out = append(out, video...)
	return append(out, body[valEnd:]...)
}

// field decodes v[key] into dst when present and not null.
func field(v map[string]json.RawMessage, key string, dst any) error {
	raw, ok := v[key]
	if !ok || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("%w: video.%s: %v", ErrInvalid, key, err)
	}
	return nil
}

// parseSource reads the optional `source` object: vendor and replay_id must
// be strings when present; other keys are kept in the chunk file only.
func parseSource(c *Chunk, raw json.RawMessage) error {
	if raw == nil || string(raw) == "null" {
		return nil
	}
	var src Source
	if err := json.Unmarshal(raw, &src); err != nil {
		return fmt.Errorf("%w: source must be an object with string vendor and replay_id: %v", ErrInvalid, err)
	}
	if src.Vendor != "" || src.ReplayID != "" {
		c.Source = &src
	}
	return nil
}

// countArray consumes a JSON array at the decoder's position, calling each
// for every element, and returns the element count.
func countArray(dec *json.Decoder, name string, each func(raw json.RawMessage, i int) error) (int, error) {
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return 0, fmt.Errorf("%w: %s must be an array", ErrInvalid, name)
	}
	n := 0
	for dec.More() {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return n, fmt.Errorf("%w: %s[%d]: %v", ErrInvalid, name, n, err)
		}
		if err := each(raw, n); err != nil {
			return n, err
		}
		n++
	}
	if _, err := dec.Token(); err != nil {
		return n, fmt.Errorf("%w: %s: %v", ErrInvalid, name, err)
	}
	return n, nil
}

type frame struct {
	TS   *int64 `json:"ts"`
	JPEG string `json:"jpeg"`
}

// validateFrame checks {ts, jpeg}: ts present, jpeg non-empty base64 that
// decodes and starts with the JPEG SOI marker. buf is reused across frames.
func validateFrame(raw json.RawMessage, i int, buf []byte) ([]byte, error) {
	var f frame
	if err := json.Unmarshal(raw, &f); err != nil {
		return buf, fmt.Errorf("%w: frames[%d]: %v", ErrInvalid, i, err)
	}
	if f.TS == nil || *f.TS <= 0 {
		return buf, fmt.Errorf("%w: frames[%d]: ts must be epoch milliseconds", ErrInvalid, i)
	}
	if f.JPEG == "" {
		return buf, fmt.Errorf("%w: frames[%d]: jpeg must be non-empty base64", ErrInvalid, i)
	}
	enc := base64.StdEncoding
	if len(f.JPEG)%4 != 0 {
		enc = base64.RawStdEncoding
	}
	need := enc.DecodedLen(len(f.JPEG))
	if cap(buf) < need {
		buf = make([]byte, need)
	}
	buf = buf[:need]
	n, err := enc.Decode(buf, []byte(f.JPEG))
	if err != nil {
		return buf, fmt.Errorf("%w: frames[%d]: jpeg is not valid base64: %v", ErrInvalid, i, err)
	}
	if n < len(jpegMagic) || !bytes.Equal(buf[:len(jpegMagic)], jpegMagic) {
		return buf, fmt.Errorf("%w: frames[%d]: jpeg does not start with the JPEG marker FF D8", ErrInvalid, i)
	}
	return buf, nil
}

type touch struct {
	TS    *int64   `json:"ts"`
	X     *float64 `json:"x"`
	Y     *float64 `json:"y"`
	Phase string   `json:"phase"`
}

func validateTouch(raw json.RawMessage, i int) error {
	var t touch
	if err := json.Unmarshal(raw, &t); err != nil {
		return fmt.Errorf("%w: touches[%d]: %v", ErrInvalid, i, err)
	}
	if t.TS == nil || *t.TS <= 0 {
		return fmt.Errorf("%w: touches[%d]: ts must be epoch milliseconds", ErrInvalid, i)
	}
	if t.X == nil || t.Y == nil {
		return fmt.Errorf("%w: touches[%d]: x and y are required", ErrInvalid, i)
	}
	if !touchPhases[t.Phase] {
		return fmt.Errorf("%w: touches[%d]: phase must be began, moved or ended", ErrInvalid, i)
	}
	return nil
}

// PeekKind returns the chunk's `kind` ("rrweb" when absent) by scanning only
// the top-level keys of the JSON object. It is used by the API to pick the
// size limit before full validation. A body that is not a JSON object yields
// rrweb; full validation reports the real error afterwards.
func PeekKind(body []byte) string {
	dec := json.NewDecoder(bytes.NewReader(body))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return KindRRWeb
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return KindRRWeb
		}
		if key, _ := keyTok.(string); key == "kind" {
			var k string
			if err := dec.Decode(&k); err != nil {
				return KindRRWeb
			}
			return normalizeKind(k)
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return KindRRWeb
		}
	}
	return KindRRWeb
}
