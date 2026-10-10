// Command rum-api is the ouo session and replay service: it stores replay
// chunks (rrweb events from the web SDK, JPEG frames from mobile), folds Loki session events into session records with a
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

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/config"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/httpapi"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/ingest"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/loki"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/project"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/replay"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/session"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/telemetry"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/tempo"
)

func main() {
	check := flag.Bool("check", false, "probe GET /healthz on the configured address and exit (container health check)")
	flag.Parse()

	cfg, err := config.FromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	if *check {
		os.Exit(healthCheck(cfg.Addr))
	}
	if err := run(cfg); err != nil {
		slog.Error("rum-api exited", "error", err)
		os.Exit(1)
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

	registry, err := project.Load(project.Source{File: cfg.ProjectsFile, ID: cfg.ProjectID, Token: cfg.ProjectToken, AllowedOrigins: cfg.AllowedOrigins})
	if err != nil {
		return fmt.Errorf("projects: %w", err)
	}
	gateway, err := ingest.New(ingest.Options{
		Registry:          registry,
		CollectorEndpoint: cfg.CollectorEndpoint,
		CollectorTimeout:  cfg.CollectorTimeout,
		MaxBodyBytes:      cfg.MaxIngestBytes,
		RateLimitRPS:      cfg.RateLimitRPS,
		RateLimitBurst:    cfg.RateLimitBurst,
		IPRateLimitRPS:    cfg.IPRateLimitRPS,
		IPRateLimitBurst:  cfg.IPRateLimitBurst,
		TrustProxy:        cfg.TrustProxy,
		// Forwarding to the collector is traced like the other outbound calls.
		HTTPClient: &http.Client{Timeout: cfg.CollectorTimeout, Transport: otelhttp.NewTransport(http.DefaultTransport)},
	})
	if err != nil {
		return fmt.Errorf("ingest gateway: %w", err)
	}

	store, err := replay.NewFS(cfg.DataDir)
	if err != nil {
		return err
	}
	// Outbound calls to Loki / Tempo are traced too.
	httpClient := &http.Client{Timeout: 60 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}
	lokiClient := loki.New(cfg.LokiURL, httpClient)
	tempoClient := tempo.New(cfg.TempoURL, httpClient, cfg.TempoConcurrency, cfg.TempoCacheTTL)
	tempoClient.Links = &tempo.LinkBuilder{GrafanaURL: cfg.GrafanaURL, DatasourceUID: cfg.TempoDatasourceUID}

	api := httpapi.New(lokiClient, tempoClient, store, httpapi.Options{
		SessionOptions:     session.Options{Inactivity: cfg.SessionInactivity, MaxDuration: cfg.SessionMaxDuration},
		ListLookback:       cfg.SessionMaxDuration,
		DetailLookback:     cfg.DetailLookback,
		MaxChunkBytes:      cfg.MaxChunkBytes,
		MaxFrameChunkBytes: cfg.MaxFrameChunkBytes,
		Gateway:            gateway,
		ReadToken:          cfg.ReadToken,
		CORSAllowedOrigins: cfg.CORSAllowedOrigins,
	})
	handler := otelhttp.NewHandler(api.Handler(), "rum-api",
		otelhttp.WithFilter(func(r *http.Request) bool {
			// No spans for probes and CORS preflights.
			return r.URL.Path != "/healthz" && r.URL.Path != "/readyz" && r.Method != http.MethodOptions
		}),
	)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second, // replay event streams can be large
		IdleTimeout:       60 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("rum-api listening",
			"addr", srv.Addr,
			"loki", cfg.LokiURL, "tempo", cfg.TempoURL, "grafana", cfg.GrafanaURL,
			"data_dir", cfg.DataDir,
			"collector", cfg.CollectorEndpoint,
			"projects", len(registry.Projects()),
			"read_token", cfg.ReadToken != "",
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
