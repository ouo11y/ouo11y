package ouoreplayreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouoreplayreceiver"

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"regexp"
)

// This file mirrors the chunk validation of rum-api
// (services/rum-api/internal/replay/parse.go, store.go). It is a copy on
// purpose: the collector must not import rum-api's internal packages, and the
// edge rejects what the sink would reject so bad chunks never reach the
// queue. Keep both in sync when the chunk contract changes (ADR-0003,
// docs/specs/mobile-replay.md).

// Replay kinds. A chunk without `kind` is rrweb.
const (
	KindRRWeb  = "rrweb"
	KindFrames = "frames"
)

// errInvalid wraps every validation failure (HTTP 400).
var errInvalid = errors.New("invalid chunk")

var (
	touchPhases = map[string]bool{"began": true, "moved": true, "ended": true}
	jpegMagic   = []byte{0xFF, 0xD8}
	// sessionIDRe: UUID-ish, safe as a path segment, at most 64 chars.
	sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
)

const maxFramesPerChunk = 1000

// maxSchemaVersion is the highest frames `schema_version` accepted (rum-api's
// SchemaVersion; ADR-0014).
const maxSchemaVersion = 2

// chunk is the validated envelope of one upload.
type chunk struct {
	Kind      string
	SessionID string
	Seq       int
	StartedAt int64
	EndedAt   int64
	Events    int
	Frames    int
	Touches   int
}

type viewport struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Scale  float64 `json:"scale"`
}

// validSessionID reports whether id can be used as a directory name.
func validSessionID(id string) bool {
	return sessionIDRe.MatchString(id) && id != "." && id != ".."
}

// parseChunk validates the envelope of either kind and counts events /
// frames / touches without keeping them. Unknown keys are tolerated.
func parseChunk(body []byte) (chunk, error) {
	var c chunk
	dec := json.NewDecoder(bytes.NewReader(body))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return c, fmt.Errorf("%w: body must be a JSON object", errInvalid)
	}
	var (
		seenEvents, seenFrames, seenTouches, seenViewport bool
		schemaVersion                                     *int
		kindSet                                           bool
		vp                                                viewport
		frames                                            frameChecker
	)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return c, fmt.Errorf("%w: %v", errInvalid, err)
		}
		key, _ := keyTok.(string)
		switch key {
		case "kind":
			kindSet = true
			if err := dec.Decode(&c.Kind); err != nil {
				return c, fmt.Errorf("%w: kind: %v", errInvalid, err)
			}
		case "schema_version":
			var v int
			if err := dec.Decode(&v); err != nil {
				return c, fmt.Errorf("%w: schema_version: %v", errInvalid, err)
			}
			schemaVersion = &v
		case "session_id":
			if err := dec.Decode(&c.SessionID); err != nil {
				return c, fmt.Errorf("%w: session_id: %v", errInvalid, err)
			}
		case "seq":
			if err := dec.Decode(&c.Seq); err != nil {
				return c, fmt.Errorf("%w: seq: %v", errInvalid, err)
			}
		case "started_at":
			if err := dec.Decode(&c.StartedAt); err != nil {
				return c, fmt.Errorf("%w: started_at: %v", errInvalid, err)
			}
		case "ended_at":
			if err := dec.Decode(&c.EndedAt); err != nil {
				return c, fmt.Errorf("%w: ended_at: %v", errInvalid, err)
			}
		case "viewport":
			seenViewport = true
			if err := dec.Decode(&vp); err != nil {
				return c, fmt.Errorf("%w: viewport: %v", errInvalid, err)
			}
		case "events":
			seenEvents = true
			n, err := countArray(dec, "events", func(json.RawMessage, int) error { return nil })
			if err != nil {
				return c, err
			}
			c.Events = n
		case "frames":
			seenFrames = true
			n, err := countArray(dec, "frames", frames.check)
			if err != nil {
				return c, err
			}
			if n > maxFramesPerChunk {
				return c, fmt.Errorf("%w: frames: at most %d per chunk", errInvalid, maxFramesPerChunk)
			}
			c.Frames = n
		case "touches":
			seenTouches = true
			n, err := countArray(dec, "touches", validateTouch)
			if err != nil {
				return c, err
			}
			c.Touches = n
		default:
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return c, fmt.Errorf("%w: %s: %v", errInvalid, key, err)
			}
		}
	}
	if _, err := dec.Token(); err != nil {
		return c, fmt.Errorf("%w: %v", errInvalid, err)
	}
	if !validSessionID(c.SessionID) {
		return c, fmt.Errorf("%w: session_id must match %s", errInvalid, sessionIDRe)
	}
	if c.Seq < 0 || c.Seq > 999999 {
		return c, fmt.Errorf("%w: seq must be between 0 and 999999", errInvalid)
	}
	if !kindSet {
		c.Kind = KindRRWeb
	}
	switch c.Kind {
	case KindRRWeb:
		if !seenEvents {
			return c, fmt.Errorf("%w: events missing", errInvalid)
		}
		if c.EndedAt < c.StartedAt {
			c.EndedAt = c.StartedAt
		}
	case KindFrames:
		if schemaVersion == nil {
			return c, fmt.Errorf("%w: schema_version missing", errInvalid)
		}
		if *schemaVersion < 1 || *schemaVersion > maxSchemaVersion {
			return c, fmt.Errorf("%w: schema_version %d not supported", errInvalid, *schemaVersion)
		}
		if c.StartedAt <= 0 {
			return c, fmt.Errorf("%w: started_at must be epoch milliseconds", errInvalid)
		}
		if c.EndedAt < c.StartedAt {
			return c, fmt.Errorf("%w: ended_at must not be before started_at", errInvalid)
		}
		if !seenViewport {
			return c, fmt.Errorf("%w: viewport missing", errInvalid)
		}
		if vp.Width <= 0 || vp.Height <= 0 {
			return c, fmt.Errorf("%w: viewport width and height must be positive", errInvalid)
		}
		if vp.Scale < 0 {
			return c, fmt.Errorf("%w: viewport scale must be positive", errInvalid)
		}
		if !seenFrames {
			return c, fmt.Errorf("%w: frames missing", errInvalid)
		}
		if *schemaVersion < 2 && frames.patchFrames > 0 {
			return c, fmt.Errorf("%w: frames with patches need schema_version 2", errInvalid)
		}
		if !seenTouches {
			c.Touches = 0
		}
	default:
		return c, fmt.Errorf("%w: kind must be %q or %q", errInvalid, KindRRWeb, KindFrames)
	}
	return c, nil
}

// countArray consumes a JSON array at the decoder's position, calling each
// for every element, and returns the element count.
func countArray(dec *json.Decoder, name string, each func(raw json.RawMessage, i int) error) (int, error) {
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return 0, fmt.Errorf("%w: %s must be an array", errInvalid, name)
	}
	n := 0
	for dec.More() {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return n, fmt.Errorf("%w: %s[%d]: %v", errInvalid, name, n, err)
		}
		if err := each(raw, n); err != nil {
			return n, err
		}
		n++
	}
	if _, err := dec.Token(); err != nil {
		return n, fmt.Errorf("%w: %s: %v", errInvalid, name, err)
	}
	return n, nil
}

type frame struct {
	TS      *int64  `json:"ts"`
	JPEG    *string `json:"jpeg"`
	Patches []patch `json:"patches"`
}

type patch struct {
	X    *int   `json:"x"`
	Y    *int   `json:"y"`
	W    *int   `json:"w"`
	H    *int   `json:"h"`
	JPEG string `json:"jpeg"`
}

// frameChecker validates the frames of one chunk in array order
// (docs/specs/mobile-replay.md, ADR-0014): every frame has ts and exactly one
// of jpeg (a full image) and patches; the first frame is a full image; every
// image is base64 starting with the JPEG marker; every patch lies inside the
// most recent full image. Schema 1 allows full images only, which the caller
// checks with patchFrames once schema_version is known.
type frameChecker struct {
	buf []byte
	// w, h: size of the most recent full image, read from its JPEG header;
	// -1 when the header is unreadable (allowed until a patch needs it).
	w, h        int
	n           int
	patchFrames int
}

func (fc *frameChecker) check(raw json.RawMessage, i int) error {
	var f frame
	if err := json.Unmarshal(raw, &f); err != nil {
		return fmt.Errorf("%w: frames[%d]: %v", errInvalid, i, err)
	}
	if f.TS == nil || *f.TS <= 0 {
		return fmt.Errorf("%w: frames[%d]: ts must be epoch milliseconds", errInvalid, i)
	}
	fc.n++
	switch {
	case f.JPEG != nil && f.Patches != nil:
		return fmt.Errorf("%w: frames[%d]: has both jpeg and patches", errInvalid, i)
	case f.JPEG != nil:
		img, err := fc.decode(*f.JPEG, fmt.Sprintf("frames[%d].jpeg", i))
		if err != nil {
			return err
		}
		fc.w, fc.h = -1, -1
		if cfg, err := jpeg.DecodeConfig(bytes.NewReader(img)); err == nil {
			fc.w, fc.h = cfg.Width, cfg.Height
		}
		return nil
	case f.Patches == nil:
		return fmt.Errorf("%w: frames[%d]: jpeg must be non-empty base64", errInvalid, i)
	}
	fc.patchFrames++
	if fc.n == 1 {
		return fmt.Errorf("%w: frames[0]: the first frame must be a full image (jpeg)", errInvalid)
	}
	if len(f.Patches) == 0 {
		return fmt.Errorf("%w: frames[%d]: patches must not be empty", errInvalid, i)
	}
	if fc.w < 0 {
		return fmt.Errorf("%w: frames[%d]: the full image before it has no readable JPEG size", errInvalid, i)
	}
	for j, p := range f.Patches {
		name := fmt.Sprintf("frames[%d].patches[%d]", i, j)
		if p.X == nil || p.Y == nil || p.W == nil || p.H == nil {
			return fmt.Errorf("%w: %s: x, y, w and h are required integers", errInvalid, name)
		}
		if *p.X < 0 || *p.Y < 0 || *p.W <= 0 || *p.H <= 0 || *p.X+*p.W > fc.w || *p.Y+*p.H > fc.h {
			return fmt.Errorf("%w: %s: must lie inside the %dx%d full image", errInvalid, name, fc.w, fc.h)
		}
		if _, err := fc.decode(p.JPEG, name+".jpeg"); err != nil {
			return err
		}
	}
	return nil
}

// decode checks that s is non-empty base64 (padded or not) of bytes starting
// with the JPEG marker and returns them (valid until the next call).
func (fc *frameChecker) decode(s, name string) ([]byte, error) {
	if s == "" {
		return nil, fmt.Errorf("%w: %s must be non-empty base64", errInvalid, name)
	}
	enc := base64.StdEncoding
	if len(s)%4 != 0 {
		enc = base64.RawStdEncoding
	}
	need := enc.DecodedLen(len(s))
	if cap(fc.buf) < need {
		fc.buf = make([]byte, need)
	}
	n, err := enc.Decode(fc.buf[:need], []byte(s))
	if err != nil {
		return nil, fmt.Errorf("%w: %s is not valid base64: %v", errInvalid, name, err)
	}
	if n < len(jpegMagic) || !bytes.Equal(fc.buf[:len(jpegMagic)], jpegMagic) {
		return nil, fmt.Errorf("%w: %s does not start with the JPEG marker FF D8", errInvalid, name)
	}
	return fc.buf[:n], nil
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
		return fmt.Errorf("%w: touches[%d]: %v", errInvalid, i, err)
	}
	if t.TS == nil || *t.TS <= 0 {
		return fmt.Errorf("%w: touches[%d]: ts must be epoch milliseconds", errInvalid, i)
	}
	if t.X == nil || t.Y == nil {
		return fmt.Errorf("%w: touches[%d]: x and y are required", errInvalid, i)
	}
	if !touchPhases[t.Phase] {
		return fmt.Errorf("%w: touches[%d]: phase must be began, moved or ended", errInvalid, i)
	}
	return nil
}

// peekKind returns the chunk's `kind` ("rrweb" when absent) by scanning only
// the top-level keys. Used to pick the size limit before full validation.
func peekKind(body []byte) string {
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
			if err := dec.Decode(&k); err != nil || k == "" {
				return KindRRWeb
			}
			return k
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return KindRRWeb
		}
	}
	return KindRRWeb
}
