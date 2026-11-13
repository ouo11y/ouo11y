// Package bff is the plugin's backend: resource endpoints that call ouo-go with the calling
// user's Clearance (ADR-0023 section 3, ADR-0024). The frontend talks to nothing else.
//
// It runs as the backend of the plugin's nested datasource (ouo11y-rum-datasource), not of
// the app: Grafana forwards the signed-in user's identity-provider tokens only to a
// datasource that sets oauthPassThru, and Clearance in groups mode reads the ID token.
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

// Settings is the datasource's jsonData. Any signed-in user can read jsonData, so the
// Clearance mapping is not here: it is the secure field "clearance".
type Settings struct {
	LokiURL      string `json:"lokiUrl"`
	MuninnURL    string `json:"muninnUrl"`
	MuninnTenant string `json:"muninnTenant"`
	// OIDC says how to verify the ID token Grafana forwards (groups mode).
	OIDC *ouogo.OIDC `json:"oidc"`
}

// App is one datasource instance (one Grafana org).
type App struct {
	backend.CallResourceHandler
	client    *ouogo.Client
	clearance ouogo.ClearanceConfig
	oidc      *ouogo.OIDC
}

// NewDatasource builds an instance from the datasource settings Grafana passes:
// jsonData (Settings) and the secure fields muninnReadToken and clearance, a JSON
// ouogo.ClearanceConfig. No clearance field means every user is level 0.
func NewDatasource(_ context.Context, s backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	var cfg Settings
	if len(s.JSONData) > 0 {
		if err := json.Unmarshal(s.JSONData, &cfg); err != nil {
			return nil, fmt.Errorf("datasource settings: %w", err)
		}
	}
	var cl ouogo.ClearanceConfig
	if v := s.DecryptedSecureJSONData["clearance"]; v != "" {
		if err := json.Unmarshal([]byte(v), &cl); err != nil {
			// The value is secret: the error says where, not what.
			return nil, errors.New("datasource settings: the secure field clearance is not a valid Clearance configuration")
		}
	}
	return New(cfg, cl, s.DecryptedSecureJSONData["muninnReadToken"]), nil
}

// New builds the BFF from settings; URL defaults are the compose stack's service names.
func New(cfg Settings, clearance ouogo.ClearanceConfig, muninnReadToken string) *App {
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
		},
		clearance: clearance,
		oidc:      cfg.OIDC,
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

// clearanceOf resolves the calling user's level. In groups mode the groups come from the
// ID token Grafana forwards in X-Id-Token, and only when it verifies against the identity
// provider's keys: a browser can send that header too, so its content alone is worth
// nothing. No token, a token that fails any check, or no OIDC settings: no groups, level 0.
func (a *App) clearanceOf(r *http.Request) ouogo.Clearance {
	var login, role string
	if u := backend.UserFromContext(r.Context()); u != nil {
		login, role = u.Login, u.Role
	}
	var groups []string
	if a.clearance.Mode == ouogo.ModeGroups && a.oidc != nil {
		var err error
		if groups, err = a.oidc.Groups(r.Context(), r.Header.Get(backend.OAuthIdentityIDTokenHeaderName)); err != nil {
			groups = nil
			log.DefaultLogger.FromContext(r.Context()).Debug("ID token not accepted, level 0", "login", login, "error", err.Error())
		}
	}
	return ouogo.Resolve(a.clearance, login, role, groups)
}

type meAnswer struct {
	ouogo.Clearance
	Can ouogo.Capabilities `json:"can"`
}

func (a *App) me(w http.ResponseWriter, r *http.Request) {
	cl := a.clearanceOf(r)
	writeJSON(w, meAnswer{Clearance: cl, Can: cl.Can()})
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
	case errors.Is(err, ouogo.ErrForbidden):
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
