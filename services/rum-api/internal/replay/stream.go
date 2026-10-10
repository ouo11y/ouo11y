package replay

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
)

// WriteEvents streams every chunk of an rrweb replay in seq order as one JSON
// array of rrweb events to w. It returns ErrNotFound when the session has no
// replay and ErrWrongKind when the replay is frames. Chunks that fail to
// decode are skipped (the player plays from the next full snapshot).
func WriteEvents(ctx context.Context, st Store, sessionID string, w io.Writer) error {
	meta, err := st.Meta(ctx, sessionID)
	if err != nil {
		return err
	}
	if meta.Kind != KindRRWeb {
		return fmt.Errorf("%w: replay of session %s is %s, use /replay/frames", ErrWrongKind, sessionID, meta.Kind)
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
// ErrNotFound when the session has no replay and ErrWrongKind for rrweb.
func WriteFrames(ctx context.Context, st Store, sessionID string, w io.Writer) error {
	meta, err := st.Meta(ctx, sessionID)
	if err != nil {
		return err
	}
	if meta.Kind != KindFrames {
		return fmt.Errorf("%w: replay of session %s is %s, use /replay/events", ErrWrongKind, sessionID, meta.Kind)
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
