package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/replay"
)

// postChunk accepts one SDK chunk (rrweb or frames), gzip or plain JSON.
//
// Size limits: the body is read up to the frames limit (8 MiB by default)
// because the kind is only known after decompression. A chunk above the
// rrweb limit (4 MiB) is then accepted only when its `kind` is frames; the
// kind peek runs only for those oversized bodies.
func (s *Server) postChunk(w http.ResponseWriter, r *http.Request) {
	limit := s.opts.MaxFrameChunkBytes
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("chunk larger than %d bytes", limit))
			return
		}
		writeError(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	var body, gzBody []byte
	switch enc := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))); enc {
	case "gzip", "x-gzip":
		gr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid gzip body: "+err.Error())
			return
		}
		body, err = io.ReadAll(io.LimitReader(gr, limit+1))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid gzip body: "+err.Error())
			return
		}
		if int64(len(body)) > limit {
			writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("decompressed chunk larger than %d bytes", limit))
			return
		}
		gzBody = raw
	case "", "identity":
		body = raw
	default:
		writeError(w, http.StatusUnsupportedMediaType, "unsupported content-encoding "+enc)
		return
	}
	if int64(len(body)) > s.opts.MaxChunkBytes && replay.PeekKind(body) != replay.KindFrames {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("rrweb chunk larger than %d bytes (only kind \"frames\" may be up to %d bytes)", s.opts.MaxChunkBytes, limit))
		return
	}

	chunk, err := s.store.Put(r.Context(), body, gzBody)
	if err != nil {
		switch {
		case errors.Is(err, replay.ErrInvalid):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, replay.ErrWrongKind):
			writeError(w, http.StatusConflict, err.Error())
		default:
			slog.Error("store chunk", "error", err)
			writeError(w, http.StatusInternalServerError, "store chunk")
		}
		return
	}
	if h := r.Header.Get("X-Ouo-Session-Id"); h != "" && h != chunk.SessionID {
		slog.Warn("x-ouo-session-id header differs from body", "header", h, "body", chunk.SessionID)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted":   true,
		"session_id": chunk.SessionID,
		"kind":       chunk.Kind,
		"seq":        chunk.Seq,
		"events":     chunk.EventCount,
		"frames":     chunk.FrameCount,
		"touches":    chunk.TouchCount,
		"bytes":      len(body),
	})
}

func (s *Server) getReplay(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	meta, err := s.store.Meta(r.Context(), id)
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "no replay for session "+id)
			return
		}
		slog.Error("read replay meta", "session_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "read replay")
		return
	}
	if meta.Chunks == nil {
		meta.Chunks = []replay.ChunkInfo{}
	}
	writeJSON(w, http.StatusOK, meta)
}

// getReplayEvents streams all rrweb chunks concatenated into one JSON array.
// 409 when the session's replay is frames.
func (s *Server) getReplayEvents(w http.ResponseWriter, r *http.Request) {
	s.streamReplay(w, r, replay.KindRRWeb, replay.WriteEvents)
}

// getReplayFrames streams all frames chunks concatenated into one object
// {session_id, kind, viewport, platform, started_at, ended_at, frames, touches}.
// 409 when the session's replay is rrweb.
func (s *Server) getReplayFrames(w http.ResponseWriter, r *http.Request) {
	s.streamReplay(w, r, replay.KindFrames, replay.WriteFrames)
}

type replayWriter func(ctx context.Context, st replay.Store, sessionID string, w io.Writer) error

// streamReplay checks existence and kind up front (so 404 / 409 can still
// be sent), then streams the body, gzip-encoded when the client accepts it.
func (s *Server) streamReplay(w http.ResponseWriter, r *http.Request, want string, write replayWriter) {
	id := r.PathValue("id")
	kind, err := s.store.Kind(r.Context(), id)
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "no replay for session "+id)
			return
		}
		slog.Error("read replay kind", "session_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "read replay")
		return
	}
	if kind != want {
		other := "/replay/events"
		if kind == replay.KindFrames {
			other = "/replay/frames"
		}
		writeError(w, http.StatusConflict, fmt.Sprintf("replay of session %s is %s, use GET /v1/sessions/%s%s", id, kind, id, other))
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Ouo-Replay-Kind", kind)
	var out io.Writer = w
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		h.Set("Content-Encoding", "gzip")
		h.Add("Vary", "Accept-Encoding")
		gw := gzip.NewWriter(w)
		defer gw.Close()
		out = gw
	}
	w.WriteHeader(http.StatusOK)
	if err := write(r.Context(), s.store, id, out); err != nil && !errors.Is(err, io.EOF) {
		// Headers are already sent; log and let the client see a truncated body.
		slog.Warn("stream replay", "session_id", id, "kind", kind, "error", err)
	}
}

func (s *Server) deleteReplay(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !replay.ValidSessionID(id) {
		writeError(w, http.StatusBadRequest, "invalid session id")
		return
	}
	if err := s.store.Delete(r.Context(), id); err != nil {
		slog.Error("delete replay", "session_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "delete replay")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
