// Package muninn implements the replay store of docs/specs/muninn.md: OTLP ingest
// (section 4), the read API (7), delete (8) and the retention sweeper (9).
package muninn

import (
	"compress/gzip"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/ouo11y/ouo11y/services/muninn/internal/config"
	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
)

// LayoutVersion is the storage layout this Muninn writes (section 6.2, schema.json).
const LayoutVersion = 1

type Server struct {
	cfg     config.Config
	store   store.Store
	keys    keys
	now     func() time.Time
	version string
	m       metrics

	mu      sync.Mutex
	headers map[string]header // chunk headers by key; immutable, so never invalidated
}

// New wraps st with the operation-duration metric and returns the server.
func New(cfg config.Config, st store.Store, version string) *Server {
	s := &Server{cfg: cfg, keys: newKeys(cfg.Storage.Prefix), now: time.Now, version: version, headers: map[string]header{}}
	s.m = newMetrics()
	s.store = timedStore{Store: st, d: s.m.storeDuration}
	return s
}

// SetClock replaces time.Now (tests).
func (s *Server) SetClock(now func() time.Time) { s.now = now }

// Init checks and writes schema.json: Muninn refuses a store written by a newer layout.
func (s *Server) Init(ctx context.Context) error {
	b, err := s.store.Get(ctx, s.keys.schema())
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err == nil {
		var sc struct {
			LayoutVersion int `json:"layout_version"`
		}
		if err := json.Unmarshal(b, &sc); err != nil {
			return fmt.Errorf("schema.json: %w", err)
		}
		if sc.LayoutVersion > LayoutVersion {
			return fmt.Errorf("store layout version %d is newer than this Muninn's %d", sc.LayoutVersion, LayoutVersion)
		}
		if sc.LayoutVersion == LayoutVersion {
			return nil
		}
	}
	out, _ := json.Marshal(map[string]any{"layout_version": LayoutVersion, "muninn_version": s.version})
	return s.store.Put(ctx, s.keys.schema(), out)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /ready", s.ready)
	mux.Handle("POST /otlp/v1/logs", recoverWith(http.StatusServiceUnavailable, http.HandlerFunc(s.ingest)))
	const base = "/api/v1/projects/{project}/sessions/{session}/replays"
	mux.Handle("GET "+base, s.api("list", s.listReplays))
	mux.Handle("DELETE "+base, s.api("delete_session", s.deleteSession))
	mux.Handle("GET "+base+"/{replay}", s.api("manifest", s.getReplay))
	mux.Handle("DELETE "+base+"/{replay}", s.api("delete_replay", s.deleteReplay))
	mux.Handle("GET "+base+"/{replay}/streams/{stream}/chunks/{seq}", s.api("chunk", s.getChunk))
	return mux
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		http.Error(w, "store unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// recoverWith answers status when a handler panics (MUN-9: never a 500 on ingest).
func recoverWith(status int, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				slog.ErrorContext(r.Context(), "panic", "path", r.URL.Path, "panic", fmt.Sprint(v))
				w.Header().Set("Retry-After", "5")
				http.Error(w, "internal error", status)
			}
		}()
		h.ServeHTTP(w, r)
	})
}

func bearerOK(r *http.Request, token string) bool {
	if token == "" {
		return true
	}
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}

// tenant reads X-Scope-OrgID (section 2): status 0 on success.
func (s *Server) tenant(r *http.Request) (string, int) {
	if !s.cfg.MultitenancyEnabled {
		return "anonymous", 0
	}
	t := r.Header.Get("X-Scope-OrgID")
	if t == "" {
		return "", http.StatusUnauthorized
	}
	if !reTenant.MatchString(t) {
		return "", http.StatusBadRequest
	}
	return t, 0
}

// --- metrics (section 11) -----------------------------------------------------------

type metrics struct {
	records, ingestBytes, readRequests, readBytes, swept metric.Int64Counter
	ingestDuration, storeDuration                        metric.Float64Histogram
}

func newMetrics() metrics {
	mt := otel.Meter("github.com/ouo11y/ouo11y/services/muninn")
	var m metrics
	m.records, _ = mt.Int64Counter("muninn.ingest.records", metric.WithDescription("Replay records by outcome"))
	m.ingestBytes, _ = mt.Int64Counter("muninn.ingest.bytes", metric.WithUnit("By"))
	m.ingestDuration, _ = mt.Float64Histogram("muninn.ingest.request.duration", metric.WithUnit("s"))
	m.readRequests, _ = mt.Int64Counter("muninn.read.requests")
	m.readBytes, _ = mt.Int64Counter("muninn.read.bytes", metric.WithUnit("By"))
	m.storeDuration, _ = mt.Float64Histogram("muninn.store.operation.duration", metric.WithUnit("s"))
	m.swept, _ = mt.Int64Counter("muninn.sweeper.deleted")
	return m
}

type timedStore struct {
	store.Store
	d metric.Float64Histogram
}

func (t timedStore) observe(ctx context.Context, op string, start time.Time, err error) {
	outcome := "ok"
	if err != nil && !errors.Is(err, store.ErrExists) && !errors.Is(err, store.ErrNotFound) {
		outcome = "error"
	}
	t.d.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(attribute.String("operation", op), attribute.String("outcome", outcome)))
}

func (t timedStore) Create(ctx context.Context, k string, b []byte, tags map[string]string) error {
	start := time.Now()
	err := t.Store.Create(ctx, k, b, tags)
	t.observe(ctx, "create", start, err)
	return err
}
func (t timedStore) Get(ctx context.Context, k string) (b []byte, err error) {
	start := time.Now()
	b, err = t.Store.Get(ctx, k)
	t.observe(ctx, "get", start, err)
	return b, err
}
func (t timedStore) GetRange(ctx context.Context, k string, off, n int64) (b []byte, err error) {
	start := time.Now()
	b, err = t.Store.GetRange(ctx, k, off, n)
	t.observe(ctx, "get_range", start, err)
	return b, err
}
func (t timedStore) List(ctx context.Context, p string) (o []store.Object, err error) {
	start := time.Now()
	o, err = t.Store.List(ctx, p)
	t.observe(ctx, "list", start, err)
	return o, err
}
func (t timedStore) Delete(ctx context.Context, k string) error {
	start := time.Now()
	err := t.Store.Delete(ctx, k)
	t.observe(ctx, "delete", start, err)
	return err
}

// --- JSON helpers -------------------------------------------------------------------

type countingWriter struct {
	http.ResponseWriter
	n      int64
	status int
}

func (c *countingWriter) WriteHeader(code int) { c.status = code; c.ResponseWriter.WriteHeader(code) }
func (c *countingWriter) Write(b []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	n, err := c.ResponseWriter.Write(b)
	c.n += int64(n)
	return n, err
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	if status == http.StatusOK && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		w.WriteHeader(status)
		gz := gzip.NewWriter(w)
		_ = json.NewEncoder(gz).Encode(v)
		_ = gz.Close()
		return
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	writeJSON(w, r, status, map[string]string{"error": msg})
}
