package httpapi

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// projectIDAttribute is the attribute every per-project metric carries; it
// is the same key the collector stamps on telemetry (ADR-0007 3).
const projectIDAttribute = "ouo.project.id"

// replayMetrics counts stored replay chunks and their decompressed bytes per
// project (ADR-0007 8). Rejected chunks are not counted.
type replayMetrics struct {
	chunks metric.Int64Counter
	bytes  metric.Int64Counter
}

// newReplayMetrics creates the counters on mp (the global provider when nil).
// The OTel API never fails to create a counter with valid options; on an
// error it returns a no-op instrument, so the error is ignored.
func newReplayMetrics(mp metric.MeterProvider) replayMetrics {
	if mp == nil {
		mp = otel.GetMeterProvider()
	}
	m := mp.Meter("github.com/ZiadMansourM/ouo/services/rum-api/internal/httpapi")
	chunks, _ := m.Int64Counter("ouo.replay.chunks", metric.WithDescription("Replay chunks stored by project"), metric.WithUnit("{chunk}"))
	bytes, _ := m.Int64Counter("ouo.replay.bytes", metric.WithDescription("Decompressed replay bytes stored by project"), metric.WithUnit("By"))
	return replayMetrics{chunks: chunks, bytes: bytes}
}

func (m replayMetrics) stored(ctx context.Context, projectID string, n int64) {
	attrs := metric.WithAttributes(attribute.String(projectIDAttribute, projectID))
	m.chunks.Add(ctx, 1, attrs)
	m.bytes.Add(ctx, n, attrs)
}
