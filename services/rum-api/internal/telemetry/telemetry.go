// Package telemetry wires the OpenTelemetry Go SDK for rum-api: traces, logs
// and metrics over OTLP/HTTP to the same collector the SDKs use
// (OTEL_EXPORTER_OTLP_ENDPOINT), with service.name=rum-api.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
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
	DefaultServiceName = "rum-api"
	ServiceVersion     = "0.1.0"
)

// Setup installs the global providers. With OTEL_SDK_DISABLED=true nothing
// is exported and slog keeps its default handler.
func Setup(ctx context.Context) (shutdown func(context.Context) error, err error) {
	if strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") {
		slog.Info("otel sdk disabled")
		return func(context.Context) error { return nil }, nil
	}
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
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))

	traceExp, err := otlptracehttp.New(ctx)
	if err != nil {
		return fail(err)
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithBatcher(traceExp))
	shutdowns = append(shutdowns, tp.Shutdown)
	otel.SetTracerProvider(tp)

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

	logExp, err := otlploghttp.New(ctx)
	if err != nil {
		return fail(err)
	}
	lp := sdklog.NewLoggerProvider(sdklog.WithResource(res), sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)))
	shutdowns = append(shutdowns, lp.Shutdown)
	global.SetLoggerProvider(lp)

	slog.SetDefault(slog.New(slog.NewMultiHandler(
		slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}),
		otelslog.NewHandler(DefaultServiceName, otelslog.WithLoggerProvider(lp)),
	)))
	return shutdown, nil
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
		resource.WithFromEnv(),
		resource.WithTelemetrySDK(),
		resource.WithAttributes(
			semconv.ServiceName(ServiceName()),
			semconv.ServiceVersion(ServiceVersion),
		),
	)
	// A schema-URL conflict is not fatal: the merged resource is still usable.
	if err != nil && !errors.Is(err, resource.ErrSchemaURLConflict) {
		return nil, err
	}
	return res, nil
}
