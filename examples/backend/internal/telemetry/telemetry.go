// Package telemetry wires the OpenTelemetry Go SDK for the demo backend:
// traces, logs and metrics over OTLP/HTTP, W3C TraceContext + Baggage
// propagation, and a span processor that copies session.id from baggage
// onto every span.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
)

const (
	DefaultServiceName = "demo-backend"
	ServiceVersion     = "0.1.0"
	Environment        = "local"
)

// Setup installs global tracer, meter and logger providers plus the
// composite TraceContext+Baggage propagator, and makes slog's default logger
// fan out to stdout and to the OTel log bridge. The returned function flushes
// and shuts everything down.
func Setup(ctx context.Context) (shutdown func(context.Context) error, err error) {
	var shutdowns []func(context.Context) error
	shutdown = func(ctx context.Context) error {
		var errs error
		for i := len(shutdowns) - 1; i >= 0; i-- {
			errs = errors.Join(errs, shutdowns[i](ctx))
		}
		return errs
	}
	fail := func(e error) (func(context.Context) error, error) {
		_ = shutdown(ctx)
		return nil, e
	}

	res, err := newResource(ctx)
	if err != nil {
		return fail(err)
	}

	otel.SetTextMapPropagator(NewPropagator())

	// Traces.
	traceExp, err := otlptracehttp.New(ctx)
	if err != nil {
		return fail(err)
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(NewBaggageSpanProcessor()),
		sdktrace.WithBatcher(traceExp),
	)
	shutdowns = append(shutdowns, tp.Shutdown)
	otel.SetTracerProvider(tp)

	// Metrics.
	metricExp, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return fail(err)
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(15*time.Second))),
	)
	shutdowns = append(shutdowns, mp.Shutdown)
	otel.SetMeterProvider(mp)

	// Logs.
	logExp, err := otlploghttp.New(ctx)
	if err != nil {
		return fail(err)
	}
	lp := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)),
	)
	shutdowns = append(shutdowns, lp.Shutdown)
	global.SetLoggerProvider(lp)

	slog.SetDefault(slog.New(slog.NewMultiHandler(
		slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}),
		otelslog.NewHandler(DefaultServiceName, otelslog.WithLoggerProvider(lp)),
	)))

	return shutdown, nil
}

// NewPropagator returns the composite W3C TraceContext + Baggage propagator
// used by both the server and the tests.
func NewPropagator() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)
}

// ServiceName is OTEL_SERVICE_NAME or DefaultServiceName.
func ServiceName() string {
	if v := os.Getenv("OTEL_SERVICE_NAME"); v != "" {
		return v
	}
	return DefaultServiceName
}

func newResource(ctx context.Context) (*resource.Resource, error) {
	res, err := resource.New(ctx,
		resource.WithFromEnv(), // OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME
		resource.WithTelemetrySDK(),
		resource.WithAttributes(
			semconv.ServiceName(ServiceName()),
			semconv.ServiceVersion(ServiceVersion),
			semconv.DeploymentEnvironmentName(Environment),
		),
	)
	// A schema-URL conflict is not fatal: the merged resource is still usable.
	if err != nil && !errors.Is(err, resource.ErrSchemaURLConflict) {
		return nil, err
	}
	return res, nil
}
