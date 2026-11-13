// Command muninn is ouo's replay store (docs/specs/muninn.md, ADR-0019): it takes
// replay chunk records from the Collector over OTLP/HTTP, keeps one object per chunk
// in object storage and serves them to the plugin BFF.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/ouo11y/ouo11y/services/muninn/internal/config"
	"github.com/ouo11y/ouo11y/services/muninn/internal/muninn"
	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
	"github.com/ouo11y/ouo11y/services/muninn/internal/telemetry"
)

// version is set at build time: -ldflags "-X main.version=<semver>".
var version = "dev"

func main() {
	configFile := flag.String("config.file", "", "YAML configuration file (config.example.yaml)")
	expandEnv := flag.Bool("config.expand-env", false, "expand ${VAR} and ${VAR:-default} in the configuration file")
	showVersion := flag.Bool("version", false, "print the version and exit")
	check := flag.Bool("check", false, "probe GET /healthz on the configured port and exit (container health check)")
	flag.Parse()
	if *showVersion {
		fmt.Println("muninn", version)
		return
	}
	cfg, err := config.Load(*configFile, *expandEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	if *check {
		resp, err := (&http.Client{Timeout: 2 * time.Second}).Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", cfg.Server.HTTPListenPort))
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	if err := run(cfg); err != nil {
		slog.Error("muninn stopped", "err", err)
		os.Exit(1)
	}
}

func run(cfg config.Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	telemetry.ServiceVersion = version
	shutdownTel, err := telemetry.Setup(ctx)
	if err != nil {
		return fmt.Errorf("telemetry: %w", err)
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTel(c)
	}()

	var st store.Store
	switch cfg.Storage.Backend {
	case "s3":
		st, err = store.NewS3(cfg.Storage.S3)
	default:
		st, err = store.NewFS(cfg.Storage.Filesystem.Directory)
	}
	if err != nil {
		return fmt.Errorf("store: %w", err)
	}
	srv := muninn.New(cfg, st, version)
	// The store may still be starting (compose): retry schema.json for a minute.
	for i := 0; ; i++ {
		if err = srv.Init(ctx); err == nil {
			break
		}
		if i >= 30 || ctx.Err() != nil {
			return fmt.Errorf("init store: %w", err)
		}
		slog.Warn("store not ready", "err", err)
		time.Sleep(2 * time.Second)
	}
	go srv.RunSweeper(ctx)

	hs := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Server.HTTPListenPort),
		Handler:           otelhttp.NewHandler(srv.Handler(), "muninn", otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/healthz" && r.URL.Path != "/ready" })),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	errc := make(chan error, 1)
	go func() { errc <- hs.ListenAndServe() }()
	slog.Info("muninn listening", "version", version, "port", cfg.Server.HTTPListenPort, "backend", cfg.Storage.Backend, "multitenancy", cfg.MultitenancyEnabled)
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return hs.Shutdown(c)
}
