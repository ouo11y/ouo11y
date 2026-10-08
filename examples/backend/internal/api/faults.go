package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
	"go.opentelemetry.io/otel/trace"
)

// Fault injection via query parameters, applied to every /api/* route:
//
//	?delay=<ms>      sleep inside a child span "db.query" (simulated slow DB)
//	?fail=500        respond 500 {"error":"payment gateway unavailable"}
//	?fail=timeout    hang for 30s so clients can exercise their timeouts
const (
	timeoutFaultDuration = 30 * time.Second
	maxDelay             = 60 * time.Second
)

var errPaymentGateway = errors.New("payment gateway unavailable")

// withFaults runs the fault injection described above before the handler.
// It returns true when the fault already wrote a response.
func (s *Server) withFaults(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()

		if raw := q.Get("delay"); raw != "" {
			ms, err := strconv.Atoi(raw)
			if err != nil || ms < 0 {
				writeError(w, http.StatusBadRequest, "delay must be a non-negative integer (milliseconds)")
				return
			}
			d := min(time.Duration(ms)*time.Millisecond, maxDelay)
			if !s.slowQuery(ctx, d, "SELECT pg_sleep($1) /* injected delay */") {
				return // client went away
			}
		}

		switch q.Get("fail") {
		case "":
		case "500":
			s.fail(ctx, w, errPaymentGateway)
			return
		case "timeout":
			span := trace.SpanFromContext(ctx)
			span.SetAttributes(attribute.String("ouo.fault", "timeout"))
			slog.WarnContext(ctx, "fault injection: hanging request", "fault", "timeout", "duration", timeoutFaultDuration.String())
			select {
			case <-time.After(timeoutFaultDuration):
				writeError(w, http.StatusGatewayTimeout, "upstream timed out")
			case <-ctx.Done():
			}
			return
		default:
			writeError(w, http.StatusBadRequest, "fail must be one of: 500, timeout")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// slowQuery opens a db.query child span that sleeps for d. It returns false
// if the request context was cancelled before the sleep finished.
func (s *Server) slowQuery(ctx context.Context, d time.Duration, statement string) bool {
	ctx, span := s.tracer.Start(ctx, "db.query", trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.DBSystemNamePostgreSQL,
			semconv.DBNamespace("store"),
			semconv.DBQueryText(statement),
			attribute.String("db.operation.name", "SELECT"),
			attribute.String("server.address", "db"),
			attribute.Int("server.port", 5432),
			attribute.Int64("ouo.fault.delay_ms", d.Milliseconds()),
		))
	defer span.End()
	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		span.SetStatus(codes.Error, "cancelled")
		span.RecordError(ctx.Err())
		return false
	}
}

// fail records err on the current span, logs it at error level and writes a
// 500 JSON error body.
func (s *Server) fail(ctx context.Context, w http.ResponseWriter, err error) {
	span := trace.SpanFromContext(ctx)
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
	span.SetAttributes(attribute.String("ouo.fault", "500"))
	slog.ErrorContext(ctx, "request failed", append([]any{"error", err.Error()}, identityLogAttrs(ctx)...)...)
	writeError(w, http.StatusInternalServerError, err.Error())
}
