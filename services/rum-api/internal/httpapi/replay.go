package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/replay"
)

// ProjectIDHeader carries the project the collector authenticated (ADR-0007
// 2 and 5): the replay exporter sets it from the chunk's `ouo.project.id`.
const ProjectIDHeader = "X-Ouo-Project-Id"

// projectIDRe matches a project id: lower-case letters, digits, `.`, `_`
// and `-`, at most 64 chars, not starting with punctuation. It is recorded
// in meta.json and used as a metric attribute, so it is kept simple.
var projectIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ValidProjectID reports whether id is acceptable in X-Ouo-Project-Id.
func ValidProjectID(id string) bool { return projectIDRe.MatchString(id) }

// videoBodyOverhead is what a video chunk body may carry besides the base64
// mp4: envelope, touches and source.
const videoBodyOverhead = 1 << 20

// videoBodyLimit is the largest video chunk body: the base64 of the largest
// mp4 plus videoBodyOverhead.
func (s *Server) videoBodyLimit() int64 {
	return int64(base64.StdEncoding.EncodedLen(int(s.opts.MaxVideoChunkBytes))) + videoBodyOverhead
}

// bodyLimit is the per-kind limit of a decompressed chunk body.
func (s *Server) bodyLimit(kind string) int64 {
	switch kind {
	case replay.KindFrames:
		return s.opts.MaxFrameChunkBytes
	case replay.KindVideo:
		return s.videoBodyLimit()
	default:
		return s.opts.MaxChunkBytes
	}
}

// postChunk is the internal replay sink (ADR-0007 5): the collector's
// `ouoreplay` exporter posts one chunk (rrweb, frames or video), gzip or
// plain JSON, with X-Ouo-Project-Id and, when OUO_INGEST_TOKEN is set, the
// bearer. Checks in order: Content-Length against the largest limit (413),
// bearer (401), project id (400), then the body.
//
// Size limits: the body is read up to the largest kind limit (frames 8 MiB,
// video base64(8 MiB) + 1 MiB by default) because the kind is only known
// after decompression. A chunk above the rrweb limit (4 MiB) is then checked
// against the limit of its `kind`; the kind peek runs only for those
// oversized bodies. The decoded mp4 of a video chunk is limited by the store
// (MaxVideoChunkBytes, 413).
func (s *Server) postChunk(w http.ResponseWriter, r *http.Request) {
	limit := max(s.opts.MaxFrameChunkBytes, s.videoBodyLimit())
	if r.ContentLength > limit {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("chunk larger than %d bytes", limit))
		return
	}
	if s.opts.IngestToken != "" && !bearerMatches(r.Header.Get("Authorization"), s.opts.IngestToken) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="ouo-rum-api"`)
		writeError(w, http.StatusUnauthorized, "ingest token required")
		return
	}
	projectID := strings.TrimSpace(r.Header.Get(ProjectIDHeader))
	switch {
	case projectID == "":
		writeError(w, http.StatusBadRequest, "missing "+ProjectIDHeader+" header")
		return
	case !ValidProjectID(projectID):
		writeError(w, http.StatusBadRequest, "invalid "+ProjectIDHeader+" header")
		return
	}

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
	if int64(len(body)) > s.opts.MaxChunkBytes {
		kind := replay.PeekKind(body)
		if kl := s.bodyLimit(kind); int64(len(body)) > kl {
			msg := fmt.Sprintf("%s chunk larger than %d bytes", kind, kl)
			if kind == replay.KindRRWeb {
				msg += fmt.Sprintf(" (kind \"frames\" may be up to %d bytes, kind \"video\" up to %d)", s.opts.MaxFrameChunkBytes, s.videoBodyLimit())
			}
			writeError(w, http.StatusRequestEntityTooLarge, msg)
			return
		}
	}

	chunk, err := s.store.Put(r.Context(), projectID, body, gzBody)
	if err != nil {
		switch {
		case errors.Is(err, replay.ErrInvalid):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, replay.ErrTooLarge):
			writeError(w, http.StatusRequestEntityTooLarge, err.Error())
		case errors.Is(err, replay.ErrWrongKind):
			writeError(w, http.StatusConflict, err.Error())
		case errors.Is(err, replay.ErrWrongProject):
			writeError(w, http.StatusForbidden, err.Error())
		default:
			slog.Error("store chunk", "error", err)
			writeError(w, http.StatusInternalServerError, "store chunk")
		}
		return
	}
	s.metrics.stored(r.Context(), projectID, int64(len(body)))
	if h := r.Header.Get("X-Ouo-Session-Id"); h != "" && h != chunk.SessionID {
		slog.Warn("x-ouo-session-id header differs from body", "header", h, "body", chunk.SessionID)
	}
	if h := r.Header.Get("X-Ouo-Seq"); h != "" && h != fmt.Sprint(chunk.Seq) {
		slog.Warn("x-ouo-seq header differs from body", "header", h, "body", chunk.Seq)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted":   true,
		"project_id": projectID,
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
// 409 when the session's replay is frames or video.
func (s *Server) getReplayEvents(w http.ResponseWriter, r *http.Request) {
	s.streamReplay(w, r, replay.KindRRWeb, replay.WriteEvents)
}

// getReplayFrames streams all frames chunks concatenated into one object
// {session_id, kind, viewport, platform, started_at, ended_at, frames, touches}.
// 409 when the session's replay is rrweb or video.
func (s *Server) getReplayFrames(w http.ResponseWriter, r *http.Request) {
	s.streamReplay(w, r, replay.KindFrames, replay.WriteFrames)
}

// getReplayVideo returns the video manifest (segments, touches, viewport,
// source). 409 when the session's replay is rrweb or frames.
func (s *Server) getReplayVideo(w http.ResponseWriter, r *http.Request) {
	s.streamReplay(w, r, replay.KindVideo, replay.WriteVideo)
}

// getReplayVideoSegment serves one mp4 through http.ServeContent: range
// requests (206), Last-Modified / ETag conditional requests, HEAD. 400 for a seq that
// is not a number, 404 without a replay or segment, 409 when the replay is
// not video.
func (s *Server) getReplayVideoSegment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	seq, err := strconv.Atoi(r.PathValue("seq"))
	if err != nil || seq < 0 || seq > 999999 {
		writeError(w, http.StatusBadRequest, "seq must be an integer between 0 and 999999")
		return
	}
	if !s.checkKind(w, r, id, replay.KindVideo) {
		return
	}
	v, err := s.store.OpenVideo(r.Context(), id, seq)
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, fmt.Sprintf("no video segment %d for session %s", seq, id))
			return
		}
		slog.Error("open video segment", "session_id", id, "seq", seq, "error", err)
		writeError(w, http.StatusInternalServerError, "read video segment")
		return
	}
	defer v.Content.Close()
	h := w.Header()
	h.Set("Content-Type", "video/mp4")
	// A re-posted seq replaces the file: let clients cache, but revalidate.
	// Last-Modified has one-second resolution, so the ETag (size and mtime in
	// ns, checked first by ServeContent) catches a replace within a second.
	h.Set("Cache-Control", "private, no-cache")
	h.Set("ETag", fmt.Sprintf(`"%x-%x"`, v.Size, v.ModTime.UnixNano()))
	h.Set("X-Ouo-Replay-Kind", replay.KindVideo)
	http.ServeContent(w, r, fmt.Sprintf("%06d.mp4", seq), v.ModTime, v.Content)
}

type replayWriter func(ctx context.Context, st replay.Store, sessionID string, w io.Writer) error

// checkKind writes 404 when the session has no replay and 409 when its kind
// is not want, and reports whether the request may go on.
func (s *Server) checkKind(w http.ResponseWriter, r *http.Request, id, want string) bool {
	kind, err := s.store.Kind(r.Context(), id)
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "no replay for session "+id)
			return false
		}
		slog.Error("read replay kind", "session_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "read replay")
		return false
	}
	if kind != want {
		writeError(w, http.StatusConflict, fmt.Sprintf("replay of session %s is %s, use GET /v1/sessions/%s%s", id, kind, id, replay.ReadPath(kind)))
		return false
	}
	return true
}

// streamReplay checks existence and kind up front (so 404 / 409 can still
// be sent), then streams the body, gzip-encoded when the client accepts it.
func (s *Server) streamReplay(w http.ResponseWriter, r *http.Request, want string, write replayWriter) {
	id := r.PathValue("id")
	if !s.checkKind(w, r, id, want) {
		return
	}
	kind := want
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
