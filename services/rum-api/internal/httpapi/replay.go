package httpapi

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/replay"
)

// postChunk accepts one SDK chunk, gzip or plain JSON.
func (s *Server) postChunk(w http.ResponseWriter, r *http.Request) {
	limit := s.opts.MaxChunkBytes
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

	chunk, err := s.store.Put(r.Context(), body, gzBody)
	if err != nil {
		if errors.Is(err, replay.ErrInvalid) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		slog.Error("store chunk", "error", err)
		writeError(w, http.StatusInternalServerError, "store chunk")
		return
	}
	if h := r.Header.Get("X-Ouo-Session-Id"); h != "" && h != chunk.SessionID {
		slog.Warn("x-ouo-session-id header differs from body", "header", h, "body", chunk.SessionID)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted":   true,
		"session_id": chunk.SessionID,
		"seq":        chunk.Seq,
		"events":     chunk.EventCount,
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

// getReplayEvents streams all chunks concatenated into one JSON array,
// gzip-encoded when the client accepts it.
func (s *Server) getReplayEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.store.Has(r.Context(), id) {
		writeError(w, http.StatusNotFound, "no replay for session "+id)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	var out io.Writer = w
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		h.Set("Content-Encoding", "gzip")
		h.Add("Vary", "Accept-Encoding")
		gw := gzip.NewWriter(w)
		defer gw.Close()
		out = gw
	}
	w.WriteHeader(http.StatusOK)
	if err := replay.WriteEvents(r.Context(), s.store, id, out); err != nil && !errors.Is(err, io.EOF) {
		// Headers are already sent; log and let the client see a truncated body.
		slog.Warn("stream replay events", "session_id", id, "error", err)
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
