// Package httpapi is the JSON API of rum-api (see services/rum-api/README.md).
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel/metric"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/loki"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/tempo"
)

// EventSource is what the API needs from Loki.
type EventSource interface {
	Events(ctx context.Context, f loki.Filters, start, end time.Time) ([]session.Event, error)
	// EventsQuery runs a raw LogQL query (the session's logs, section Logs).
	EventsQuery(ctx context.Context, query string, start, end time.Time) ([]session.Event, error)
	Ready(ctx context.Context) error
}

// TraceSource is what the API needs from Tempo.
type TraceSource interface {
	SessionTraces(ctx context.Context, sessionID string, start, end time.Time) ([]tempo.Trace, error)
	Ready(ctx context.Context) error
}

// Options tune the handlers.
type Options struct {
	SessionOptions     session.Options
	ListLookback       time.Duration            // extra Loki lookback before `from` so sessions started earlier still fold completely
	DetailLookback     time.Duration            // how far back a single-session lookup searches
	MaxChunkBytes      int64                    // rrweb chunks (decompressed); default 4 MiB
	MaxFrameChunkBytes int64                    // kind frames chunks (decompressed); default 8 MiB, never below MaxChunkBytes
	MaxVideoChunkBytes int64                    // decoded mp4 of a kind video chunk; default 8 MiB, never below MaxChunkBytes. The store enforces it (MaxVideoBytes on replay.FS / replay.S3); here it sizes the body limit
	IngestToken        string                   // OUO_INGEST_TOKEN: when set, POST /v1/replay/chunks needs `Authorization: Bearer <token>`
	ReadToken          string                   // OUO_READ_TOKEN: when set, GET and DELETE /v1/* need `Authorization: Bearer <token>`
	AdminToken         string                   // OUO_ADMIN_TOKEN: bearer of /v1/admin/*; empty disables the admin API
	Admin              *Admin                   // deletions, audit log, retention sweep (nil: admin API disabled)
	Sampling           map[string]SamplingRates // server-side per-project replay sampling cap (projects.<id>.sampling)
	CORSAllowedOrigins []string                 // CORS_ALLOWED_ORIGINS: exact extra origins besides http://localhost:* and http://127.0.0.1:*
	TraceLinks         *tempo.LinkBuilder       // Explore links for log lines' traces (nil: none)
	LokiLinks          *loki.LinkBuilder        // Explore link for the session's log query (nil: none)
	SourceMaps         *SourceMaps              // source-map upload and symbolication (nil: disabled, ADR-0011)
	MeterProvider      metric.MeterProvider
	Now                func() time.Time
}

// Server holds the dependencies of the handlers.
type Server struct {
	events  EventSource
	traces  TraceSource
	store   replay.Store
	opts    Options
	metrics replayMetrics
}

// New wires the handlers onto a ServeMux and returns the root handler.
func New(events EventSource, traces TraceSource, store replay.Store, opts Options) *Server {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ListLookback <= 0 {
		opts.ListLookback = 4 * time.Hour
	}
	if opts.DetailLookback <= 0 {
		opts.DetailLookback = 168 * time.Hour
	}
	if opts.MaxChunkBytes <= 0 {
		opts.MaxChunkBytes = 4 << 20
	}
	if opts.MaxFrameChunkBytes <= 0 {
		opts.MaxFrameChunkBytes = 8 << 20
	}
	opts.MaxFrameChunkBytes = max(opts.MaxFrameChunkBytes, opts.MaxChunkBytes)
	if opts.MaxVideoChunkBytes <= 0 {
		opts.MaxVideoChunkBytes = replay.DefaultMaxVideoBytes
	}
	opts.MaxVideoChunkBytes = max(opts.MaxVideoChunkBytes, opts.MaxChunkBytes)
	return &Server{events: events, traces: traces, store: store, opts: opts, metrics: newReplayMetrics(opts.MeterProvider)}
}

// Handler returns the routed handler with CORS and the read token applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("POST /v1/replay/chunks", s.postChunk)
	mux.HandleFunc("GET /v1/sessions", s.listSessions)
	mux.HandleFunc("GET /v1/sessions/{id}", s.getSession)
	mux.HandleFunc("GET /v1/sessions/{id}/traces", s.getSessionTraces)
	mux.HandleFunc("GET /v1/sessions/{id}/logs", s.getSessionLogs)
	mux.HandleFunc("GET /v1/sessions/{id}/vitals", s.getSessionVitals)
	mux.HandleFunc("GET /v1/sessions/{id}/replay", s.getReplay)
	mux.HandleFunc("GET /v1/sessions/{id}/replay/events", s.getReplayEvents)
	mux.HandleFunc("GET /v1/sessions/{id}/replay/frames", s.getReplayFrames)
	mux.HandleFunc("GET /v1/sessions/{id}/replay/video", s.getReplayVideo)
	mux.HandleFunc("GET /v1/sessions/{id}/replay/video/{seq}", s.getReplayVideoSegment)
	mux.HandleFunc("DELETE /v1/sessions/{id}/replay", s.deleteReplay)
	mux.HandleFunc("GET /v1/stats/health", s.statsHealth)
	mux.HandleFunc("PUT /v1/sourcemaps", s.putSourceMap)
	mux.HandleFunc("GET /v1/sourcemaps", s.listSourceMaps)
	mux.HandleFunc("POST /v1/symbolicate", s.postSymbolicate)
	mux.HandleFunc("DELETE /v1/admin/users/{user}", s.adminAuth(s.deleteUser))
	mux.HandleFunc("DELETE /v1/admin/projects/{project}", s.adminAuth(s.deleteProject))
	mux.HandleFunc("GET /v1/admin/audit", s.adminAuth(s.getAudit))
	mux.HandleFunc("POST /v1/admin/retention/sweep", s.adminAuth(s.postSweep))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	return cors(s.opts.CORSAllowedOrigins, readAuth(s.opts.ReadToken, mux))
}

// bearerMatches compares `Authorization: Bearer <token>` in constant time.
func bearerMatches(header, token string) bool {
	scheme, cred, ok := strings.Cut(strings.TrimSpace(header), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return false
	}
	cred = strings.TrimSpace(cred)
	return subtle.ConstantTimeCompare([]byte(cred), []byte(token)) == 1
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	checks := map[string]string{}
	ok := true
	probes := map[string]func(context.Context) error{"loki": s.events.Ready, "tempo": s.traces.Ready}
	if p, ok := s.store.(replay.Pinger); ok {
		probes["storage"] = p.Ready
	}
	for name, probe := range probes {
		if err := probe(ctx); err != nil {
			checks[name] = err.Error()
			ok = false
		} else {
			checks[name] = "ok"
		}
	}
	status := http.StatusOK
	if !ok {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"ready": ok, "checks": checks})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Debug("write response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func isNotFound(err error) bool { return errors.Is(err, replay.ErrNotFound) }
