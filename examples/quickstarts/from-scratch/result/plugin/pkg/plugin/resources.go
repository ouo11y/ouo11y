package plugin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
	"github.com/ouo11y/ouo11y/libs/ouo-go/redact"
)

func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /sessions", a.sessions)
	mux.HandleFunc("GET /sessions/{project}/{session}", a.session)
	mux.HandleFunc("GET /sessions/{project}/{session}/replays/{replay}", a.manifest)
	mux.HandleFunc("GET /sessions/{project}/{session}/replays/{replay}/streams/{stream}/chunks/{seq}", a.chunk)
}

// Your access model goes here. This one: Grafana Viewers never see who the user was.
// Editors and Admins see everything. Replace it with yours (teams, IdP groups, nothing).
func hideIdentity(r *http.Request) bool {
	u := backend.UserFromContext(r.Context())
	return u == nil || u.Role == "Viewer" || u.Role == "None"
}

// GET /sessions: the sessions of the last 24 hours, newest first.
func (a *App) sessions(w http.ResponseWriter, r *http.Request) {
	list, err := a.loki.ListSessions(r.Context(), ouogo.SessionQuery{Project: r.URL.Query().Get("project")})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if hideIdentity(r) {
		redact.Sessions(list.Sessions, redact.Identity)
	}
	writeJSON(w, list)
}

type sessionAnswer struct {
	*ouogo.SessionEvents
	Replays []ouogo.ReplaySummary `json:"replays"`
}

// GET /sessions/{project}/{session}: the session's events from Loki and its replays from Muninn.
func (a *App) session(w http.ResponseWriter, r *http.Request) {
	project, session := r.PathValue("project"), r.PathValue("session")
	events, err := a.loki.SessionEvents(r.Context(), project, session, ouogo.TimeRange{})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	replays, err := a.muninn.ListReplays(r.Context(), project, session)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if hideIdentity(r) {
		redact.Session(&events.Session, redact.Identity)
		redact.Events(events.Events, redact.Identity)
	}
	writeJSON(w, sessionAnswer{SessionEvents: events, Replays: replays})
}

// GET .../replays/{replay}: the replay's manifest, what @ouo11y/kit's ReplayPlayer plays.
func (a *App) manifest(w http.ResponseWriter, r *http.Request) {
	m, err := a.muninn.Manifest(r.Context(), r.PathValue("project"), r.PathValue("session"), r.PathValue("replay"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if hideIdentity(r) {
		redact.Manifest(m, redact.Identity)
	}
	writeJSON(w, m)
}

// GET .../streams/{stream}/chunks/{seq}: one chunk's bytes, decompressed.
func (a *App) chunk(w http.ResponseWriter, r *http.Request) {
	seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if err != nil {
		writeErr(w, r, &ouogo.BadRequestError{Msg: "sequence must be an integer"})
		return
	}
	c, err := a.muninn.Chunk(r.Context(), r.PathValue("project"), r.PathValue("session"),
		r.PathValue("replay"), r.PathValue("stream"), seq)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(c.Body)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store") // a changed access rule applies at once
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr logs the full error (it carries store URLs and queries) and answers a short one.
func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var bad *ouogo.BadRequestError
	var store *ouogo.BackendError
	switch {
	case errors.As(err, &bad):
		http.Error(w, bad.Msg, http.StatusBadRequest)
	case errors.Is(err, ouogo.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.As(err, &store):
		log.DefaultLogger.Error("store read failed", "path", r.URL.Path, "error", store.Error())
		http.Error(w, store.Public(), http.StatusBadGateway)
	default:
		log.DefaultLogger.Error("request failed", "path", r.URL.Path, "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}
