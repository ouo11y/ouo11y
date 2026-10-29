// Command rum-api is the ouo session and replay service: it stores replay
// chunks (rrweb events from the web SDK, JPEG frames from mobile, mp4 segments
// from the Sentry bridge), folds Loki session events into session records with a
// health status, lists traces per session from Tempo and serves the JSON API
// used by the Grafana app plugin. See README.md for the API.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/audit"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/config"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/httpapi"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/lifecycle"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/loki"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/sourcemap"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/telemetry"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/tempo"
)

// version is set at build time: -ldflags "-X main.version=<semver>" (Dockerfile ARG VERSION).
var version = "dev"

func main() {
	configFile := flag.String("config.file", "", "YAML configuration file (config.example.yaml); environment variables override it")
	expandEnv := flag.Bool("config.expand-env", false, "expand ${VAR} and ${VAR:-default} references in the configuration file")
	verify := flag.Bool("config.verify", false, "load and validate the configuration, print it with secrets redacted and exit (0 valid, 2 invalid)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	check := flag.Bool("check", false, "probe GET /healthz on the configured address and exit (container health check)")
	flag.Parse()
	if *showVersion {
		fmt.Println("rum-api", version)
		return
	}

	cfg, err := config.Load(*configFile, *expandEnv, os.LookupEnv)
	if *check {
		// The probe only needs the listen address: a config the server would
		// refuse (or one the HEALTHCHECK cannot see) must not hide that.
		os.Exit(healthCheck(cfg.Server.HTTPListenAddress))
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	if *verify {
		out, err := cfg.Redacted().YAML()
		if err != nil {
			fmt.Fprintln(os.Stderr, "config:", err)
			os.Exit(2)
		}
		os.Stdout.Write(out)
		for _, w := range cfg.Warnings() {
			fmt.Fprintln(os.Stderr, "config: warning:", w)
		}
		fmt.Fprintln(os.Stderr, "config: valid")
		return
	}
	if err := run(cfg); err != nil {
		slog.Error("rum-api exited", "error", err)
		os.Exit(1)
	}
}

// retentionPolicy is the replay retention from retention.replays and the
// projects.<id>.retention.replays overrides.
func retentionPolicy(cfg config.Config) lifecycle.Policy {
	p := lifecycle.Policy{Default: cfg.Retention.Replays, Projects: map[string]time.Duration{}}
	for id, pr := range cfg.Projects {
		if pr.Retention.Replays > 0 {
			p.Projects[id] = pr.Retention.Replays
		}
	}
	return p
}

// samplingCaps are the projects with a server-side sampling override.
func samplingCaps(cfg config.Config) map[string]httpapi.SamplingRates {
	out := map[string]httpapi.SamplingRates{}
	for id, pr := range cfg.Projects {
		if pr.Sampling.SessionRate == nil && pr.Sampling.ReplayRate == nil && pr.Sampling.ReplayOnErrorRate == nil {
			continue
		}
		r := httpapi.SamplingRates{SessionRate: 1, ReplayRate: 1, ReplayOnErrorRate: 1}
		if pr.Sampling.SessionRate != nil {
			r.SessionRate = *pr.Sampling.SessionRate
		}
		if pr.Sampling.ReplayRate != nil {
			r.ReplayRate = *pr.Sampling.ReplayRate
		}
		if pr.Sampling.ReplayOnErrorRate != nil {
			r.ReplayOnErrorRate = *pr.Sampling.ReplayOnErrorRate
		}
		out[id] = r
	}
	return out
}

// newAuditLog opens the deletion audit log next to the replays: a file under
// the data directory, or objects under [<prefix>/]audit/ in the bucket.
func newAuditLog(cfg config.Config, store replay.Store) (audit.Log, string, error) {
	if s3, ok := store.(*replay.S3); ok {
		return audit.Bucket{Store: replay.AuditObjects{S3: s3}}, "s3 " + cfg.Storage.S3.Bucket + "/" + strings.TrimPrefix(cfg.Storage.S3.Prefix+"/audit/", "/"), nil
	}
	f, err := audit.NewFile(cfg.Storage.Filesystem.Dir)
	if err != nil {
		return nil, "", err
	}
	return f, f.Path(), nil
}

// sourceMapRetention is retention.sourcemaps with the per-project overrides.
func sourceMapRetention(cfg config.Config) func(string) time.Duration {
	return func(project string) time.Duration {
		if p, ok := cfg.Projects[project]; ok && p.Retention.SourceMaps > 0 {
			return p.Retention.SourceMaps
		}
		return cfg.Retention.SourceMaps
	}
}

// s3SourceMapObjects adapts the bucket's sourcemaps/ prefix to sourcemap.Objects.
type s3SourceMapObjects struct{ replay.Objects }

func (o s3SourceMapObjects) List(ctx context.Context, prefix string) ([]sourcemap.ObjectInfo, error) {
	objs, err := o.Objects.List(ctx, prefix)
	out := make([]sourcemap.ObjectInfo, len(objs))
	for i, ob := range objs {
		out[i] = sourcemap.ObjectInfo{Key: ob.Key, ModTime: time.Unix(0, ob.ModTime)}
	}
	return out, err
}

// newSourceMaps opens the source-map store next to the replays (ADR-0011 2).
func newSourceMaps(cfg config.Config, store replay.Store) (*httpapi.SourceMaps, error) {
	var objs sourcemap.Objects
	if s3, ok := store.(*replay.S3); ok {
		objs = s3SourceMapObjects{replay.Objects{S3: s3, Dir: "sourcemaps"}}
	} else {
		fsObjs, err := sourcemap.NewFSObjects(cfg.Storage.Filesystem.Dir)
		if err != nil {
			return nil, err
		}
		objs = fsObjs
	}
	st := &sourcemap.Store{Objects: objs, MaxBytes: cfg.Limits.MaxSourceMapBytes, MaxDSYMBytes: cfg.Limits.MaxDSYMBytes, Retention: sourceMapRetention(cfg)}
	tokens := map[string]string{}
	for id, p := range cfg.Projects {
		if p.UploadToken != "" {
			tokens[id] = p.UploadToken
		}
	}
	return &httpapi.SourceMaps{
		Store:        st,
		Symbolicator: sourcemap.NewSymbolicator(st, sourcemap.Options{CacheEntries: cfg.SourceMaps.CacheEntries, CacheBytes: cfg.SourceMaps.CacheBytes, CacheTTL: cfg.SourceMaps.CacheTTL}),
		UploadTokens: tokens,
	}, nil
}

// sweepSourceMaps deletes expired source maps every interval.
func sweepSourceMaps(ctx context.Context, st *sourcemap.Store, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if n, err := st.Sweep(ctx); err != nil {
			slog.Warn("source map sweep failed", "error", err)
		} else if n > 0 {
			slog.Info("source maps expired", "deleted", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// newStore opens the replay store selected by storage.backend.
func newStore(ctx context.Context, cfg config.Config) (replay.Store, error) {
	switch cfg.Storage.Backend {
	case config.BackendS3:
		o := cfg.Storage.S3
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		st, err := replay.NewS3(ctx, replay.S3Options{
			Endpoint: o.Endpoint, Bucket: o.Bucket, Region: o.Region,
			AccessKeyID: o.AccessKeyID, SecretAccessKey: o.SecretAccessKey, SessionToken: o.SessionToken,
			Insecure: o.Insecure, InsecureSkipVerify: o.InsecureSkipVerify, ForcePathStyle: o.ForcePathStyle,
			Prefix: o.Prefix,
		})
		if err != nil {
			return nil, err
		}
		st.MaxVideoBytes = cfg.Limits.MaxVideoChunkBytes
		st.Retention = retentionPolicy(cfg).For
		if o.LifecycleRules {
			if err := st.ApplyLifecycleRules(ctx, retentionPolicy(cfg).All()); err != nil {
				return nil, fmt.Errorf("storage.s3.lifecycle_rules: %w", err)
			}
			slog.Info("bucket lifecycle rules applied", "bucket", o.Bucket, "retentions", retentionPolicy(cfg).All())
		}
		return st, nil
	default:
		st, err := replay.NewFS(cfg.Storage.Filesystem.Dir)
		if err != nil {
			return nil, err
		}
		st.MaxVideoBytes = cfg.Limits.MaxVideoChunkBytes
		return st, nil
	}
}

func run(cfg config.Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdownTelemetry, err := telemetry.Setup(ctx)
	if err != nil {
		return fmt.Errorf("telemetry setup: %w", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownTelemetry(ctx); err != nil {
			slog.Error("telemetry shutdown", "error", err)
		}
	}()

	store, err := newStore(ctx, cfg)
	if err != nil {
		return fmt.Errorf("replay store: %w", err)
	}
	// Refuse a store last opened by a rum-api with a newer replay schema
	// (docs/operations/upgrade.md section 4): exit 1 before serving anything.
	if ms, ok := store.(replay.SchemaMarkerStore); ok {
		if err := replay.CheckSchema(ctx, ms, version, time.Now()); err != nil {
			return err
		}
	}
	// Outbound calls to Loki / Tempo are traced too.
	httpClient := &http.Client{Timeout: 60 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}
	lokiClient := loki.New(cfg.Loki.URL, httpClient)
	tempoClient := tempo.New(cfg.Tempo.URL, httpClient, cfg.Tempo.Concurrency, cfg.Tempo.CacheTTL)
	tempoClient.Links = &tempo.LinkBuilder{GrafanaURL: cfg.Grafana.URL, DatasourceUID: cfg.Tempo.DatasourceUID}
	lokiLinks := &loki.LinkBuilder{GrafanaURL: cfg.Grafana.URL, DatasourceUID: cfg.Loki.DatasourceUID}

	// Data lifecycle (docs/operations/data-lifecycle.md): retention sweeper,
	// deletions and their audit log.
	sweeper := lifecycle.NewSweeper(store.(lifecycle.SweepStore), retentionPolicy(cfg), cfg.Retention.OrphanGrace, nil)
	if cfg.Retention.SweepInterval > 0 {
		go sweeper.Run(ctx, cfg.Retention.SweepInterval)
	}
	sourceMaps, err := newSourceMaps(cfg, store)
	if err != nil {
		return fmt.Errorf("source maps: %w", err)
	}
	if cfg.Retention.SweepInterval > 0 && cfg.Retention.SourceMaps > 0 {
		go sweepSourceMaps(ctx, sourceMaps.Store, cfg.Retention.SweepInterval)
	}
	for _, w := range cfg.Warnings() {
		slog.Warn("config: " + w)
	}
	auditLog, auditWhere, err := newAuditLog(cfg, store)
	if err != nil {
		return fmt.Errorf("audit log: %w", err)
	}
	deleter := lifecycle.NewDeleter(lifecycle.Deleter{
		Store: store.(lifecycle.DeleteStore), Audit: auditLog, Logs: lokiClient, Traces: tempoClient, SourceMaps: sourceMaps.Store,
		LokiDeletes: cfg.Loki.DeleteAPI, LogRetention: cfg.Retention.Logs, MaxSessionDuration: cfg.Session.MaxDuration,
	}, nil)

	api := httpapi.New(lokiClient, tempoClient, store, httpapi.Options{
		SessionOptions:     session.Options{Inactivity: cfg.Session.Inactivity, MaxDuration: cfg.Session.MaxDuration},
		ListLookback:       cfg.Session.MaxDuration,
		DetailLookback:     cfg.Session.DetailLookback,
		MaxChunkBytes:      cfg.Limits.MaxChunkBytes,
		MaxFrameChunkBytes: cfg.Limits.MaxFrameChunkBytes,
		MaxVideoChunkBytes: cfg.Limits.MaxVideoChunkBytes,
		IngestToken:        cfg.Auth.IngestToken,
		ReadToken:          cfg.Auth.ReadToken,
		AdminToken:         cfg.Auth.AdminToken,
		Admin:              &httpapi.Admin{Deleter: deleter, Sweeper: sweeper, Audit: auditLog},
		Sampling:           samplingCaps(cfg),
		CORSAllowedOrigins: cfg.Server.CORSAllowedOrigins,
		TraceLinks:         tempoClient.Links,
		LokiLinks:          lokiLinks,
		SourceMaps:         sourceMaps,
		FunnelCacheTTL:     cfg.Loki.FunnelCacheTTL,
	})
	handler := otelhttp.NewHandler(api.Handler(), "rum-api",
		otelhttp.WithFilter(func(r *http.Request) bool {
			// No spans for probes and CORS preflights.
			return r.URL.Path != "/healthz" && r.URL.Path != "/readyz" && r.Method != http.MethodOptions
		}),
	)

	srv := &http.Server{
		Addr:              cfg.Server.HTTPListenAddress,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second, // replay event streams can be large
		IdleTimeout:       60 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("rum-api listening",
			"version", version,
			"addr", srv.Addr,
			"loki", cfg.Loki.URL, "tempo", cfg.Tempo.URL, "grafana", cfg.Grafana.URL,
			"storage", storageDesc(cfg),
			"ingest_token", cfg.Auth.IngestToken != "",
			"read_token", cfg.Auth.ReadToken != "",
			"admin_api", cfg.Auth.AdminToken != "",
			"replay_retention", cfg.Retention.Replays, "sweep_interval", cfg.Retention.SweepInterval,
			"audit_log", auditWhere,
			"sourcemap_upload_projects", len(sourceMaps.UploadTokens), "sourcemap_retention", cfg.Retention.SourceMaps,
			"otlp.endpoint", os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
		)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// healthCheck lets the distroless image (no shell, no curl) run a container
// HEALTHCHECK: `rum-api -check`.
func healthCheck(addr string) int {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		port = strings.TrimPrefix(addr, ":")
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "unhealthy:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "unhealthy: status", resp.StatusCode)
		return 1
	}
	return 0
}

// storageDesc names the replay store for the startup log (no secrets).
func storageDesc(cfg config.Config) string {
	if cfg.Storage.Backend == config.BackendS3 {
		o := cfg.Storage.S3
		return fmt.Sprintf("s3://%s/%s (endpoint %q)", o.Bucket, o.Prefix, o.Endpoint)
	}
	return "filesystem " + cfg.Storage.Filesystem.Dir
}
