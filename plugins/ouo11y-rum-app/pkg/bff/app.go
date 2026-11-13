// Package bff is the plugin's backend: resource endpoints that call ouo-go with the calling
// Grafana user's Clearance (ADR-0023 section 3). The frontend talks to nothing else.
package bff

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// Settings is the plugin's jsonData as far as the BFF reads it. The MVP pages' keys
// (rumApiUrl, featureToggles) sit beside these.
type Settings struct {
	LokiURL      string `json:"lokiUrl"`
	MuninnURL    string `json:"muninnUrl"`
	MuninnTenant string `json:"muninnTenant"`
	TempoURL     string `json:"tempoUrl"`
	// GrafanaURL is where the backend reaches Grafana's own API (team lookups). The backend
	// runs inside Grafana's container, so the default is http://localhost:3000.
	GrafanaURL string                `json:"grafanaUrl"`
	Clearance  ouogo.ClearanceConfig `json:"clearance"`
}

// App is one plugin instance (one Grafana org).
type App struct {
	backend.CallResourceHandler
	client    *ouogo.Client
	clearance ouogo.ClearanceConfig
	teamNames []string
	teams     *teams
}

// NewApp builds an instance from the app settings Grafana passes.
func NewApp(_ context.Context, s backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	var cfg Settings
	if len(s.JSONData) > 0 {
		if err := json.Unmarshal(s.JSONData, &cfg); err != nil {
			return nil, fmt.Errorf("plugin settings: %w", err)
		}
	}
	return New(cfg, s.DecryptedSecureJSONData["muninnReadToken"]), nil
}

// New builds the BFF from settings; defaults are the compose stack's service names.
func New(cfg Settings, muninnReadToken string) *App {
	def := func(v, d string) string {
		if v == "" {
			return d
		}
		return v
	}
	a := &App{
		client: &ouogo.Client{
			Loki: &ouogo.Loki{URL: def(cfg.LokiURL, "http://loki:3100"), HTTP: &http.Client{Timeout: 60 * time.Second}},
			Muninn: &ouogo.Muninn{
				URL:       def(cfg.MuninnURL, "http://muninn:3400"),
				Tenant:    def(cfg.MuninnTenant, "anonymous"),
				ReadToken: muninnReadToken,
			},
			Tempo: &ouogo.Tempo{URL: def(cfg.TempoURL, "http://tempo:3200"), HTTP: &http.Client{Timeout: 30 * time.Second}},
		},
		clearance: cfg.Clearance,
		teamNames: cfg.Clearance.TeamNames(),
		teams:     newTeams(def(cfg.GrafanaURL, "http://localhost:3000")),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/me", a.me)
	mux.HandleFunc("GET /v1/sessions", a.sessions)
	mux.HandleFunc("GET /v1/projects/{project}/sessions/{session}", a.session)
	mux.HandleFunc("GET /v1/projects/{project}/sessions/{session}/replays/{replay}", a.manifest)
	mux.HandleFunc("GET /v1/projects/{project}/sessions/{session}/replays/{replay}/streams/{stream}/chunks/{seq}", a.chunk)
	a.CallResourceHandler = httpadapter.New(mux)
	return a
}

// clearanceOf resolves the calling user's levels. No user (should not happen through
// Grafana) is level 0. When the settings name teams, the user's teams are looked up; if that
// fails, the user is resolved without teams (never with more than role and login give).
func (a *App) clearanceOf(r *http.Request) ouogo.Clearance {
	u := backend.UserFromContext(r.Context())
	if u == nil {
		return ouogo.Clearance{}
	}
	teams, err := a.teams.of(r.Context(), a.teamNames, u.Login)
	if err != nil {
		log.DefaultLogger.FromContext(r.Context()).Error("team lookup failed; resolving without teams", "error", err.Error())
	}
	return ouogo.Resolve(a.clearance, u.Login, u.Role, teams)
}

type meAnswer struct {
	ouogo.Clearance
	// Project is the project level and can are for (?project=), or empty for the org.
	Project string             `json:"project,omitempty"`
	Can     ouogo.Capabilities `json:"can"`
}

func (a *App) me(w http.ResponseWriter, r *http.Request) {
	cl := a.clearanceOf(r)
	p := r.URL.Query().Get("project")
	if p != "" {
		cl = cl.For(p)
	}
	writeJSON(w, meAnswer{Clearance: cl, Project: p, Can: cl.Can()})
}

func (a *App) sessions(w http.ResponseWriter, r *http.Request) {
	tr, err := timeRange(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	out, err := a.client.ListSessions(r.Context(), a.clearanceOf(r), ouogo.SessionQuery{
		TimeRange: tr, Project: r.URL.Query().Get("project"), Limit: limit,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, out)
}

func (a *App) session(w http.ResponseWriter, r *http.Request) {
	tr, err := timeRange(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	out, err := a.client.GetSession(r.Context(), a.clearanceOf(r), r.PathValue("project"), r.PathValue("session"), tr)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if out.ReplaysErr != nil {
		log.DefaultLogger.FromContext(r.Context()).Error("replay list failed", "path", r.URL.Path, "error", out.ReplaysErr.Error())
	}
	if out.TracesErr != nil {
		log.DefaultLogger.FromContext(r.Context()).Error("trace search failed", "path", r.URL.Path, "error", out.TracesErr.Error())
	}
	writeJSON(w, out)
}

func (a *App) manifest(w http.ResponseWriter, r *http.Request) {
	out, err := a.client.GetManifest(r.Context(), a.clearanceOf(r), r.PathValue("project"), r.PathValue("session"), r.PathValue("replay"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, out)
}

func (a *App) chunk(w http.ResponseWriter, r *http.Request) {
	seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if err != nil {
		writeErr(w, r, &ouogo.BadRequestError{Msg: "sequence must be an integer"})
		return
	}
	out, err := a.client.GetChunk(r.Context(), a.clearanceOf(r), r.PathValue("project"), r.PathValue("session"),
		r.PathValue("replay"), r.PathValue("stream"), seq)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Ouo-Replay-Format", out.Format)
	// no-store: a lowered Clearance level must take effect at once, also for bytes already seen.
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(out.Body)
}

// timeRange reads from and to, in ms since the epoch; absent means the last 24 hours.
func timeRange(r *http.Request) (ouogo.TimeRange, error) {
	var tr ouogo.TimeRange
	for _, p := range []struct {
		name string
		dst  *time.Time
	}{{"from", &tr.From}, {"to", &tr.To}} {
		v := r.URL.Query().Get(p.name)
		if v == "" {
			continue
		}
		ms, err := strconv.ParseInt(v, 10, 64)
		if err != nil || ms <= 0 {
			return tr, &ouogo.BadRequestError{Msg: p.name + " must be milliseconds since the epoch"}
		}
		*p.dst = time.UnixMilli(ms)
	}
	return tr, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	// Users see the status and a short message; URLs, queries and store answers go to the log.
	status, msg := http.StatusInternalServerError, "internal error"
	var bad *ouogo.BadRequestError
	var be *ouogo.BackendError
	switch {
	case errors.Is(err, ouogo.ErrForbidden): // includes ErrUnmasked, whose message says why
		status, msg = http.StatusForbidden, err.Error()
	case errors.Is(err, ouogo.ErrNotFound):
		status, msg = http.StatusNotFound, err.Error()
	case errors.As(err, &bad):
		status, msg = http.StatusBadRequest, err.Error()
	case errors.As(err, &be):
		status, msg = http.StatusBadGateway, be.Public()
	}
	if status >= 500 {
		log.DefaultLogger.FromContext(r.Context()).Error("resource request failed", "path", r.URL.Path, "error", err.Error())
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
