package replay

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
)

// ReadPath is the read endpoint (below /v1/sessions/{id}) of a replay kind.
func ReadPath(kind string) string {
	switch kind {
	case KindFrames:
		return "/replay/frames"
	case KindVideo:
		return "/replay/video"
	default:
		return "/replay/events"
	}
}

// WriteEvents streams every chunk of an rrweb replay in seq order as one JSON
// array of rrweb events to w. It returns ErrNotFound when the session has no
// replay and ErrWrongKind when the replay is of another kind. Chunks that fail to
// decode are skipped (the player plays from the next full snapshot).
func WriteEvents(ctx context.Context, st Store, sessionID string, w io.Writer) error {
	meta, err := st.Meta(ctx, sessionID)
	if err != nil {
		return err
	}
	if meta.Kind != KindRRWeb {
		return fmt.Errorf("%w: replay of session %s is %s, use %s", ErrWrongKind, sessionID, meta.Kind, ReadPath(meta.Kind))
	}
	if _, err := io.WriteString(w, "["); err != nil {
		return err
	}
	first := true
	for _, ch := range meta.Chunks {
		if err := ctx.Err(); err != nil {
			return err
		}
		rc, err := st.OpenChunk(ctx, sessionID, ch.Seq)
		if err != nil {
			continue
		}
		err = copyArray(rc, "events", func(raw json.RawMessage) error { return writeElem(w, raw, &first) })
		rc.Close()
		if err != nil {
			return err
		}
	}
	_, err = io.WriteString(w, "]")
	return err
}

// WriteFrames streams a frames replay as
// {session_id, kind, viewport, platform, started_at, ended_at, frames: [...], touches: [...]}
// with the frames and touches of every chunk concatenated in seq order.
// Frames are copied through without re-encoding (they hold the base64 JPEGs);
// touches are small and buffered until the frames array is closed. It returns
// ErrNotFound when the session has no replay and ErrWrongKind for another kind.
func WriteFrames(ctx context.Context, st Store, sessionID string, w io.Writer) error {
	meta, err := st.Meta(ctx, sessionID)
	if err != nil {
		return err
	}
	if meta.Kind != KindFrames {
		return fmt.Errorf("%w: replay of session %s is %s, use %s", ErrWrongKind, sessionID, meta.Kind, ReadPath(meta.Kind))
	}
	head, err := json.Marshal(struct {
		SessionID string    `json:"session_id"`
		Kind      string    `json:"kind"`
		Viewport  *Viewport `json:"viewport"`
		Platform  string    `json:"platform"`
		StartedAt int64     `json:"started_at"`
		EndedAt   int64     `json:"ended_at"`
	}{meta.SessionID, meta.Kind, meta.Viewport, meta.Platform, meta.StartedAt, meta.EndedAt})
	if err != nil {
		return err
	}
	// Reopen the object: drop the closing brace and continue with the arrays.
	if _, err := w.Write(head[:len(head)-1]); err != nil {
		return err
	}
	if _, err := io.WriteString(w, `,"frames":[`); err != nil {
		return err
	}
	var touches []json.RawMessage
	first := true
	for _, ch := range meta.Chunks {
		if err := ctx.Err(); err != nil {
			return err
		}
		rc, err := st.OpenChunk(ctx, sessionID, ch.Seq)
		if err != nil {
			continue
		}
		err = copyArrays(rc, map[string]func(json.RawMessage) error{
			"frames": func(raw json.RawMessage) error { return writeElem(w, raw, &first) },
			"touches": func(raw json.RawMessage) error {
				touches = append(touches, raw)
				return nil
			},
		})
		rc.Close()
		if err != nil {
			return err
		}
	}
	if _, err := io.WriteString(w, `],"touches":[`); err != nil {
		return err
	}
	first = true
	for _, t := range touches {
		if err := writeElem(w, t, &first); err != nil {
			return err
		}
	}
	_, err = io.WriteString(w, "]}")
	return err
}

// VideoManifest is the body of GET /v1/sessions/{id}/replay/video
// (sentry-bridge.md 11): the segments in seq order with the path of each mp4,
// and every touch of every chunk in seq order.
type VideoManifest struct {
	SessionID string            `json:"session_id"`
	Kind      string            `json:"kind"`
	Viewport  *Viewport         `json:"viewport"`
	Platform  string            `json:"platform"`
	StartedAt int64             `json:"started_at"`
	EndedAt   int64             `json:"ended_at"`
	Segments  []VideoSegment    `json:"segments"`
	Touches   []json.RawMessage `json:"touches"`
	Source    *Source           `json:"source"`
}

// VideoSegment is one mp4 of a video replay. Bytes is the mp4 size; Path is
// the rum-api path that serves it (relative to the API root).
type VideoSegment struct {
	Seq        int    `json:"seq"`
	StartedAt  int64  `json:"started_at"`
	EndedAt    int64  `json:"ended_at"`
	DurationMs int64  `json:"duration_ms"`
	FrameCount int    `json:"frame_count"`
	Bytes      int64  `json:"bytes"`
	Path       string `json:"path"`
}

// BuildVideoManifest reads a video replay's meta and the touches of its
// chunk files. It returns ErrNotFound when the session has no replay and
// ErrWrongKind for another kind. Chunk files that fail to decode contribute
// no touches; their segment is still listed.
func BuildVideoManifest(ctx context.Context, st Store, sessionID string) (VideoManifest, error) {
	meta, err := st.Meta(ctx, sessionID)
	if err != nil {
		return VideoManifest{}, err
	}
	if meta.Kind != KindVideo {
		return VideoManifest{}, fmt.Errorf("%w: replay of session %s is %s, use %s", ErrWrongKind, sessionID, meta.Kind, ReadPath(meta.Kind))
	}
	m := VideoManifest{
		SessionID: meta.SessionID, Kind: meta.Kind, Viewport: meta.Viewport, Platform: meta.Platform,
		StartedAt: meta.StartedAt, EndedAt: meta.EndedAt, Source: meta.Source,
		Segments: make([]VideoSegment, 0, len(meta.Chunks)), Touches: []json.RawMessage{},
	}
	for _, ch := range meta.Chunks {
		if err := ctx.Err(); err != nil {
			return VideoManifest{}, err
		}
		d := ch.EndedAt - ch.StartedAt
		if ch.DurationMs != nil {
			d = *ch.DurationMs
		}
		m.Segments = append(m.Segments, VideoSegment{
			Seq: ch.Seq, StartedAt: ch.StartedAt, EndedAt: ch.EndedAt, DurationMs: d,
			FrameCount: ch.FrameCount, Bytes: ch.VideoBytes,
			Path: fmt.Sprintf("/v1/sessions/%s/replay/video/%d", sessionID, ch.Seq),
		})
		rc, err := st.OpenChunk(ctx, sessionID, ch.Seq)
		if err != nil {
			continue
		}
		copyArray(rc, "touches", func(raw json.RawMessage) error {
			m.Touches = append(m.Touches, raw)
			return nil
		})
		rc.Close()
	}
	return m, nil
}

// WriteVideo writes the video manifest of a session as JSON to w (same
// errors as BuildVideoManifest).
func WriteVideo(ctx context.Context, st Store, sessionID string, w io.Writer) error {
	m, err := BuildVideoManifest(ctx, st, sessionID)
	if err != nil {
		return err
	}
	return json.NewEncoder(w).Encode(m)
}

func writeElem(w io.Writer, raw json.RawMessage, first *bool) error {
	if !*first {
		if _, err := io.WriteString(w, ","); err != nil {
			return err
		}
	}
	*first = false
	_, err := w.Write(raw)
	return err
}

// copyArray finds one top-level array in a chunk and hands its elements to fn.
func copyArray(r io.Reader, key string, fn func(json.RawMessage) error) error {
	return copyArrays(r, map[string]func(json.RawMessage) error{key: fn})
}

// copyArrays walks the top-level keys of a chunk object; arrays named in fns
// are streamed element by element to their function, everything else is
// skipped. A corrupt chunk is skipped silently (returns nil); only write
// errors from fn are returned.
func copyArrays(r io.Reader, fns map[string]func(json.RawMessage) error) error {
	dec := json.NewDecoder(r)
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil
		}
		key, _ := keyTok.(string)
		fn, want := fns[key]
		if !want {
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return nil
			}
			continue
		}
		if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
			return nil
		}
		for dec.More() {
			var raw json.RawMessage
			if err := dec.Decode(&raw); err != nil {
				return nil
			}
			if err := fn(raw); err != nil {
				return err
			}
		}
		if _, err := dec.Token(); err != nil {
			return nil
		}
	}
	return nil
}
