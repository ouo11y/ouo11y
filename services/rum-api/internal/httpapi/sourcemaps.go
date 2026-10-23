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

// putSourceMap: PUT /v1/sourcemaps?debug_id=&release=&file= with the map as
// the body (Content-Encoding: gzip allowed) and the project's upload token.
func (s *Server) putSourceMap(w http.ResponseWriter, r *http.Request) {
	sm := s.opts.SourceMaps
	if sm == nil || sm.Store == nil {
		writeError(w, http.StatusNotFound, "source maps are not configured")
		return
	}
	project, ok := sm.uploadProject(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="ouo-rum-api"`)
		writeError(w, http.StatusUnauthorized, "upload token required")
		return
	}
	if p := r.URL.Query().Get("project"); p != "" && p != project {
		writeError(w, http.StatusForbidden, "the upload token belongs to project "+project)
		return
	}
	limit := sm.Store.MaxBytes
	if limit <= 0 {
		limit = sourcemap.DefaultMaxBytes
	}
	var body io.Reader = http.MaxBytesReader(w, r.Body, limit+1)
	if strings.EqualFold(r.Header.Get("Content-Encoding"), "gzip") {
		zr, err := gzip.NewReader(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid gzip body")
			return
		}
		defer zr.Close()
		body = zr
	}
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "source map too large")
			return
		}
		writeError(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	q := r.URL.Query()
	meta, err := sm.Store.Put(r.Context(), sourcemap.Upload{
		ProjectID: project, DebugID: q.Get("debug_id"), Release: q.Get("release"), File: q.Get("file"), Map: data,
	})
	switch {
	case errors.Is(err, sourcemap.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, err.Error())
		return
	case errors.Is(err, sourcemap.ErrInvalid):
		writeError(w, http.StatusBadRequest, err.Error())
		return
	case err != nil:
		slog.Error("store source map", "project_id", project, "error", err)
		writeError(w, http.StatusBadGateway, "store source map: "+err.Error())
		return
	}
	if sm.Symbolicator != nil {
		sm.Symbolicator.Evict(sourcemap.Ref{ProjectID: project, DebugID: meta.DebugID})
		sm.Symbolicator.Evict(sourcemap.Ref{ProjectID: project, Release: meta.Release, URL: meta.File})
	}
	slog.Info("source map stored", "project_id", project, "debug_id", meta.DebugID, "release", meta.Release, "file", meta.File, "bytes", meta.Bytes)
	writeJSON(w, http.StatusCreated, meta)
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
	if !sourcemap.ValidProject(req.ProjectID) || strings.TrimSpace(req.Stacktrace) == "" {
		writeError(w, http.StatusBadRequest, "project_id and stacktrace are required")
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
	res, err := sm.Symbolicator.Symbolicate(ctx, req)
	if err != nil {
		slog.Warn("symbolication failed", "project_id", project, "error", err)
		return nil
	}
	return &res
}
