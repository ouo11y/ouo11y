// Package httpapi is the JSON API of rum-api (see services/rum-api/README.md).
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/loki"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/replay"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/session"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/tempo"
)

// EventSource is what the API needs from Loki.
type EventSource interface {
	Events(ctx context.Context, f loki.Filters, start, end time.Time) ([]session.Event, error)
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
	ListLookback       time.Duration // extra Loki lookback before `from` so sessions started earlier still fold completely
	DetailLookback     time.Duration // how far back a single-session lookup searches
	MaxChunkBytes      int64         // rrweb chunks (decompressed); default 4 MiB
	MaxFrameChunkBytes int64         // kind frames chunks (decompressed); default 8 MiB, never below MaxChunkBytes
	CORSAllowedOrigins []string
	Now                func() time.Time
}

// Server holds the dependencies of the handlers.
type Server struct {
	events EventSource
	traces TraceSource
	store  replay.Store
	opts   Options
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
	return &Server{events: events, traces: traces, store: store, opts: opts}
}

// Handler returns the routed handler with CORS applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("POST /v1/replay/chunks", s.postChunk)
	mux.HandleFunc("GET /v1/sessions", s.listSessions)
	mux.HandleFunc("GET /v1/sessions/{id}", s.getSession)
	mux.HandleFunc("GET /v1/sessions/{id}/traces", s.getSessionTraces)
	mux.HandleFunc("GET /v1/sessions/{id}/replay", s.getReplay)
	mux.HandleFunc("GET /v1/sessions/{id}/replay/events", s.getReplayEvents)
	mux.HandleFunc("GET /v1/sessions/{id}/replay/frames", s.getReplayFrames)
	mux.HandleFunc("DELETE /v1/sessions/{id}/replay", s.deleteReplay)
	mux.HandleFunc("GET /v1/stats/health", s.statsHealth)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	return cors(s.opts.CORSAllowedOrigins, mux)
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	checks := map[string]string{}
	ok := true
	for name, probe := range map[string]func(context.Context) error{"loki": s.events.Ready, "tempo": s.traces.Ready} {
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
