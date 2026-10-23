package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/audit"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/lifecycle"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/sampling"
)

// Admin is the operator API behind OUO_ADMIN_TOKEN (/v1/admin/*): deletions,
// the audit log and an on-demand retention sweep. Nil fields disable the
// matching endpoints.
type Admin struct {
	Deleter *lifecycle.Deleter
	Sweeper *lifecycle.Sweeper
	Audit   audit.Log
}

// ActorHeader names who asked for a deletion (recorded in the audit log).
const ActorHeader = "X-Ouo-Actor"

// adminAuth guards /v1/admin/*: 404 when no admin token is configured (the
// API does not exist), 401 without the bearer. The read token never opens it.
func (s *Server) adminAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.opts.AdminToken == "" || s.opts.Admin == nil {
			writeError(w, http.StatusNotFound, "admin API disabled (set auth.admin_token / OUO_ADMIN_TOKEN)")
			return
		}
		if !bearerMatches(r.Header.Get("Authorization"), s.opts.AdminToken) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="ouo-rum-api-admin"`)
			writeError(w, http.StatusUnauthorized, "admin token required")
			return
		}
		next(w, r)
	}
}

// deletionRequest reads ?reason=, ?dry_run= and the actor header.
func deletionRequest(r *http.Request) (lifecycle.Request, error) {
	q := r.URL.Query()
	req := lifecycle.Request{Reason: q.Get("reason"), Actor: strings.TrimSpace(r.Header.Get(ActorHeader))}
	if req.Actor == "" {
		req.Actor = "admin-token"
	}
	if v := q.Get("dry_run"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return req, errors.New("dry_run must be true or false")
		}
		req.DryRun = b
	}
	return req, nil
}

// deleteUser: DELETE /v1/admin/users/{user}[?project=<id>&reason=&dry_run=].
func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	req, err := deletionRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.UserID = r.PathValue("user")
	if p := r.URL.Query().Get("project"); p != "" {
		if !ValidProjectID(p) {
			writeError(w, http.StatusBadRequest, "invalid project id")
			return
		}
		req.ProjectID = p
	}
	if req.UserID == "" || len(req.UserID) > 256 {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	s.runDeletion(w, r, req, s.opts.Admin.Deleter.DeleteUser)
}

// deleteProject: DELETE /v1/admin/projects/{project}[?reason=&dry_run=].
func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	req, err := deletionRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.ProjectID = r.PathValue("project")
	if !ValidProjectID(req.ProjectID) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	s.runDeletion(w, r, req, s.opts.Admin.Deleter.DeleteProject)
}

func (s *Server) runDeletion(w http.ResponseWriter, r *http.Request, req lifecycle.Request,
	run func(context.Context, lifecycle.Request) (audit.Entry, error)) {
	if s.opts.Admin.Deleter == nil {
		writeError(w, http.StatusNotFound, "deletions are not configured")
		return
	}
	e, err := run(r.Context(), req)
	switch {
	case errors.Is(err, lifecycle.ErrAudit):
		// Nothing was deleted.
		slog.Error("deletion refused: audit log unavailable", "error", err)
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case err != nil:
		// Partly done: the failed audit entry says what was and was not.
		slog.Error("deletion failed", "id", e.ID, "action", e.Action, "error", err)
		writeJSON(w, http.StatusBadGateway, e)
	default:
		slog.Info("deletion completed", "id", e.ID, "action", e.Action, "user_id", e.UserID, "project_id", e.ProjectID,
			"sessions", e.SessionCount, "dry_run", e.DryRun, "actor", e.Actor)
		writeJSON(w, http.StatusOK, e)
	}
}

// getAudit: GET /v1/admin/audit[?limit=N] (newest N entries, oldest first).
func (s *Server) getAudit(w http.ResponseWriter, r *http.Request) {
	if s.opts.Admin.Audit == nil {
		writeError(w, http.StatusNotFound, "audit log is not configured")
		return
	}
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "limit must be a non-negative integer")
			return
		}
		limit = n
	}
	entries, err := s.opts.Admin.Audit.List(r.Context(), limit)
	if err != nil {
		slog.Error("read audit log", "error", err)
		writeError(w, http.StatusInternalServerError, "read audit log")
		return
	}
	if entries == nil {
		entries = []audit.Entry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// postSweep: POST /v1/admin/retention/sweep runs one retention pass now.
func (s *Server) postSweep(w http.ResponseWriter, r *http.Request) {
	if s.opts.Admin.Sweeper == nil {
		writeError(w, http.StatusNotFound, "the retention sweeper is not configured")
		return
	}
	res, err := s.opts.Admin.Sweeper.SweepOnce(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error(), "result": res})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// sampledOut applies the project's server-side sampling cap to a replay
// chunk (config projects.<id>.sampling): false keeps it. A chunk carries no
// sign of why the SDK recorded it, so a session in the session sample is
// kept when it passes either replay decision: the replay rate or the
// on-error rate. The SDKs only record an on-error session after an error,
// so the second test keeps their error-triggered replays and nothing else.
func (s *Server) sampledOut(projectID, sessionID string) bool {
	rates, ok := s.opts.Sampling[projectID]
	if !ok {
		return false
	}
	if !sampling.Sampled(sessionID, rates.SessionRate, sampling.Session) {
		return true
	}
	return !sampling.Sampled(sessionID, rates.ReplayRate, sampling.Replay) &&
		!sampling.Sampled(sessionID, rates.ReplayOnErrorRate, sampling.ReplayOnError)
}

// SamplingRates is one project's server-side cap (1 keeps everything).
type SamplingRates struct {
	SessionRate       float64
	ReplayRate        float64
	ReplayOnErrorRate float64
}
