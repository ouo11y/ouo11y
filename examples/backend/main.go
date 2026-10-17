// Command demo-backend is the Go API the ouo demo web and mobile apps call.
// It is instrumented with the OpenTelemetry Go SDK so that client spans and
// backend spans join into one trace, and copies the session.id propagated in
// W3C Baggage onto every span and log record.
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
	"syscall"
	"time"

	"github.com/ouo11y/ouo11y/examples/backend/internal/api"
	"github.com/ouo11y/ouo11y/examples/backend/internal/telemetry"
)

const defaultPort = "8081"

func main() {
	check := flag.Bool("check", false, "probe GET /healthz on the configured port and exit (for container health checks)")
	flag.Parse()

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}
	if *check {
		os.Exit(healthCheck(port))
	}
	if err := run(port); err != nil {
		slog.Error("demo-backend exited", "error", err)
		os.Exit(1)
	}
}

func run(port string) error {
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

	srv := &http.Server{
		Addr:              net.JoinHostPort("", port),
		Handler:           api.New().Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// WriteTimeout must exceed the ?fail=timeout fault (30s) so the
		// request really hangs instead of being cut by the server.
		WriteTimeout: 45 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("demo-backend listening",
			"addr", srv.Addr,
			"service.name", telemetry.ServiceName(),
			"service.version", telemetry.ServiceVersion,
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
// HEALTHCHECK: `demo-backend -check`.
func healthCheck(port string) int {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
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
