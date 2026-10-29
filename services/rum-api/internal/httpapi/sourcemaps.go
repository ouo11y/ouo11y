package httpapi

import (
	"compress/gzip"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/sourcemap"
)

// symbolicateTimeout bounds the symbolication of one response (map loads
// included); past it the remaining exceptions are served raw.
const symbolicateTimeout = 5 * time.Second

// SourceMaps wires the source-map store and the symbolicator (ADR-0011).
type SourceMaps struct {
	Store        *sourcemap.Store
	Symbolicator *sourcemap.Symbolicator
	// UploadTokens maps a project id to its secret upload token
	// (projects.<id>.upload_token). A project without one cannot upload.
	UploadTokens map[string]string
}

// uploadProject returns the project whose upload token the request carries.
func (sm *SourceMaps) uploadProject(r *http.Request) (string, bool) {
	scheme, cred, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	cred = strings.TrimSpace(cred)
	project := ""
	for id, tok := range sm.UploadTokens {
		// Compare against every token (no early exit) so timing says nothing.
		if tok != "" && subtle.ConstantTimeCompare([]byte(cred), []byte(tok)) == 1 {
			project = id
		}
	}
	return project, project != ""
}

// readUpload authenticates an upload by its project upload token and reads
// its body (Content-Encoding: gzip allowed) up to limit bytes decompressed.
// It writes the error response itself when ok is false.
func (s *Server) readUpload(w http.ResponseWriter, r *http.Request, limit int64) (project string, data []byte, ok bool) {
	sm := s.opts.SourceMaps
	if sm == nil || sm.Store == nil {
		writeError(w, http.StatusNotFound, "source maps are not configured")
		return "", nil, false
	}
	project, ok = sm.uploadProject(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="ouo-rum-api"`)
		writeError(w, http.StatusUnauthorized, "upload token required")
		return "", nil, false
	}
	if p := r.URL.Query().Get("project"); p != "" && p != project {
		writeError(w, http.StatusForbidden, "the upload token belongs to project "+project)
		return "", nil, false
	}
	var body io.Reader = http.MaxBytesReader(w, r.Body, limit+1)
	if strings.EqualFold(r.Header.Get("Content-Encoding"), "gzip") {
		zr, err := gzip.NewReader(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid gzip body")
			return "", nil, false
		}
		defer zr.Close()
		body = zr
	}
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "upload too large")
			return "", nil, false
		}
		writeError(w, http.StatusBadRequest, "read body: "+err.Error())
		return "", nil, false
	}
	return project, data, true
}

// writeStoreError answers a failed Put / PutDSYM.
func writeStoreError(w http.ResponseWriter, project, what string, err error) {
	switch {
	case errors.Is(err, sourcemap.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, err.Error())
	case errors.Is(err, sourcemap.ErrInvalid):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		slog.Error("store "+what, "project_id", project, "error", err)
		writeError(w, http.StatusBadGateway, "store "+what+": "+err.Error())
	}
}

// putSourceMap: PUT /v1/sourcemaps?debug_id=&release=&file= with the map as
// the body (Content-Encoding: gzip allowed) and the project's upload token.
func (s *Server) putSourceMap(w http.ResponseWriter, r *http.Request) {
	limit := int64(sourcemap.DefaultMaxBytes)
	if sm := s.opts.SourceMaps; sm != nil && sm.Store != nil && sm.Store.MaxBytes > 0 {
		limit = sm.Store.MaxBytes
	}
	project, data, ok := s.readUpload(w, r, limit)
	if !ok {
		return
	}
	sm := s.opts.SourceMaps
	q := r.URL.Query()
	meta, err := sm.Store.Put(r.Context(), sourcemap.Upload{
		ProjectID: project, DebugID: q.Get("debug_id"), Release: q.Get("release"), File: q.Get("file"), Map: data,
	})
	if err != nil {
		writeStoreError(w, project, "source map", err)
		return
	}
	if sm.Symbolicator != nil {
		sm.Symbolicator.Evict(sourcemap.Ref{ProjectID: project, DebugID: meta.DebugID})
		sm.Symbolicator.Evict(sourcemap.Ref{ProjectID: project, Release: meta.Release, URL: meta.File})
	}
	slog.Info("source map stored", "project_id", project, "debug_id", meta.DebugID, "release", meta.Release, "file", meta.File, "bytes", meta.Bytes)
	writeJSON(w, http.StatusCreated, meta)
}

// putDSYM: PUT /v1/dsyms?file=&release= with one DWARF file of a .dSYM
// bundle (Contents/Resources/DWARF/<name>, thin or universal) as the body
// and the project's upload token. Every architecture slice is stored under
// its LC_UUID; the response lists them.
func (s *Server) putDSYM(w http.ResponseWriter, r *http.Request) {
	limit := int64(sourcemap.DefaultMaxDSYMBytes)
	if sm := s.opts.SourceMaps; sm != nil && sm.Store != nil && sm.Store.MaxDSYMBytes > 0 {
		limit = sm.Store.MaxDSYMBytes
	}
	project, data, ok := s.readUpload(w, r, limit)
	if !ok {
		return
	}
	sm := s.opts.SourceMaps
	q := r.URL.Query()
	metas, err := sm.Store.PutDSYM(r.Context(), sourcemap.DSYMUpload{ProjectID: project, Release: q.Get("release"), File: q.Get("file"), Data: data})
	if err != nil {
		writeStoreError(w, project, "dSYM", err)
		return
	}
	for _, m := range metas {
		if sm.Symbolicator != nil {
			sm.Symbolicator.Evict(sourcemap.Ref{ProjectID: project, DebugID: m.DebugID, DSYM: true})
		}
		slog.Info("dSYM stored", "project_id", project, "debug_id", m.DebugID, "arch", m.Arch, "file", m.File, "bytes", m.Bytes)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"project_id": project, "dsyms": metas})
}

// listSourceMaps: GET /v1/sourcemaps?project=<id> (read token).
func (s *Server) listSourceMaps(w http.ResponseWriter, r *http.Request) {
	sm := s.opts.SourceMaps
	if sm == nil || sm.Store == nil {
		writeError(w, http.StatusNotFound, "source maps are not configured")
		return
	}
	project := r.URL.Query().Get("project")
	if !sourcemap.ValidProject(project) {
		writeError(w, http.StatusBadRequest, "project is required")
		return
	}
	ms, err := sm.Store.List(r.Context(), project)
	if err != nil {
		writeError(w, http.StatusBadGateway, "list source maps: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project_id": project, "sourcemaps": ms, "count": len(ms)})
}

// postSymbolicate: POST /v1/symbolicate (read token), body sourcemap.Request.
func (s *Server) postSymbolicate(w http.ResponseWriter, r *http.Request) {
	sm := s.opts.SourceMaps
	if sm == nil || sm.Symbolicator == nil {
		writeError(w, http.StatusNotFound, "source maps are not configured")
		return
	}
	var req sourcemap.Request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if !sourcemap.ValidProject(req.ProjectID) || strings.TrimSpace(req.Stacktrace) == "" && len(req.Frames) == 0 {
		writeError(w, http.StatusBadRequest, "project_id and stacktrace (or native frames) are required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), symbolicateTimeout)
	defer cancel()
	res, err := sm.Symbolicator.Symbolicate(ctx, req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// symbolicateEvent symbolicates an exception record with a stack, or
// returns nil (no stack, no project, maps not configured, backend failure).
// A native crash (ouo.crash.frames, ouo.crash.images) goes through the dSYMs.
// The raw attributes are never changed.
func (s *Server) symbolicateEvent(ctx context.Context, ev session.Event) *sourcemap.Result {
	sm := s.opts.SourceMaps
	if sm == nil || sm.Symbolicator == nil || ev.Name != "exception" {
		return nil
	}
	stack := ev.Attrs["exception_stacktrace"]
	project := ev.Attrs["ouo_project_id"]
	if strings.TrimSpace(stack) == "" || project == "" {
		return nil
	}
	req := sourcemap.Request{ProjectID: project, Release: ev.ServiceVersion, Stacktrace: stack}
	if raw := ev.Attrs["ouo_exception_debug_ids"]; raw != "" {
		_ = json.Unmarshal([]byte(raw), &req.DebugIDs) // a malformed value just means no debug ids
	}
	if raw := ev.Attrs["ouo_crash_frames"]; raw != "" {
		// Malformed values just leave the frames out: the stack is then treated as JavaScript.
		if json.Unmarshal([]byte(raw), &req.Frames) == nil {
			_ = json.Unmarshal([]byte(ev.Attrs["ouo_crash_images"]), &req.Images)
		}
	}
	res, err := sm.Symbolicator.Symbolicate(ctx, req)
	if err != nil {
		slog.Warn("symbolication failed", "project_id", project, "error", err)
		return nil
	}
	return &res
}
