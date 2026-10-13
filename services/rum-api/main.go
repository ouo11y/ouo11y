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

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/config"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/httpapi"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/loki"
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

	store, err := replay.NewFS(cfg.DataDir)
	if err != nil {
		return err
	}
	store.MaxVideoBytes = cfg.MaxVideoChunkBytes
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
		MaxVideoChunkBytes: cfg.MaxVideoChunkBytes,
		IngestToken:        cfg.IngestToken,
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
			"ingest_token", cfg.IngestToken != "",
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
