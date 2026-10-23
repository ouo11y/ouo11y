// Package lifecycle expires and deletes replay data
// (docs/operations/data-lifecycle.md): the retention sweeper and
// delete-by-user / delete-by-project with their audit trail.
package lifecycle

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
)

// Policy is the replay retention: Default for every project, Projects for
// the overrides. 0 keeps replays forever.
type Policy struct {
	Default  time.Duration
	Projects map[string]time.Duration
}

// For returns projectID's retention.
func (p Policy) For(projectID string) time.Duration {
	if d, ok := p.Projects[projectID]; ok && d > 0 {
		return d
	}
	return p.Default
}

// All is every retention in use (default and overrides), for the bucket
// lifecycle rules.
func (p Policy) All() []time.Duration {
	out := []time.Duration{p.Default}
	for _, d := range p.Projects {
		out = append(out, d)
	}
	return out
}

// SweepStore is what the sweeper needs from the replay store.
type SweepStore interface {
	replay.Lister
	Delete(ctx context.Context, sessionID string) error
}

// Sweeper deletes replays older than their project's retention, measured
// from the session's last stored chunk (meta.json updated_at), and session
// prefixes without meta.json whose newest object is older than OrphanGrace
// (default 1h). It is idempotent:
// several replicas may sweep the same store, a session deleted twice is
// simply absent the second time.
type Sweeper struct {
	Store       SweepStore
	Policy      Policy
	OrphanGrace time.Duration
	Now         func() time.Time
	metrics     sweepMetrics
}

// NewSweeper wires the metrics on mp (the global provider when nil).
func NewSweeper(st SweepStore, p Policy, orphanGrace time.Duration, mp metric.MeterProvider) *Sweeper {
	return &Sweeper{Store: st, Policy: p, OrphanGrace: orphanGrace, Now: time.Now, metrics: newSweepMetrics(mp)}
}

// SweepResult is one pass.
type SweepResult struct {
	Scanned  int           `json:"scanned"`
	Expired  int           `json:"expired"`
	Orphans  int           `json:"orphans"`
	Bytes    int64         `json:"bytes"`
	Errors   int           `json:"errors"`
	Duration time.Duration `json:"duration_ns"`
}

// SweepOnce runs one pass over the store.
func (s *Sweeper) SweepOnce(ctx context.Context) (SweepResult, error) {
	now := s.now()
	var res SweepResult
	err := s.Store.Sessions(ctx, func(e replay.SessionEntry) error {
		res.Scanned++
		project, bytes, orphan := "", int64(0), e.Meta == nil
		var keep time.Duration
		if orphan {
			// A first chunk is written before its meta.json: the grace keeps
			// an upload in flight.
			keep = s.OrphanGrace
			if keep <= 0 {
				keep = time.Hour
			}
		} else {
			project, bytes = e.Meta.ProjectID, e.Meta.Bytes
			keep = s.Policy.For(project)
			if keep <= 0 {
				return nil
			}
		}
		if e.LastModified.IsZero() || now.Sub(e.LastModified) < keep {
			return nil
		}
		if err := s.Store.Delete(ctx, e.ID); err != nil {
			res.Errors++
			slog.Warn("retention sweep: delete failed", "session_id", e.ID, "error", err)
			return nil
		}
		if orphan {
			res.Orphans++
		} else {
			res.Expired++
		}
		res.Bytes += bytes
		s.metrics.deleted(ctx, project, orphan, bytes)
		slog.Debug("retention sweep: deleted", "session_id", e.ID, "project_id", project, "orphan", orphan,
			"last_modified", e.LastModified, "retention", keep)
		return nil
	})
	res.Duration = s.now().Sub(now)
	s.metrics.pass(ctx, res, err)
	return res, err
}

// Run sweeps every interval until ctx ends, starting with one pass.
func (s *Sweeper) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		res, err := s.SweepOnce(ctx)
		if err != nil && ctx.Err() == nil {
			slog.Error("retention sweep failed", "error", err, "scanned", res.Scanned)
		} else if res.Expired+res.Orphans > 0 || res.Errors > 0 {
			slog.Info("retention sweep", "scanned", res.Scanned, "expired", res.Expired, "orphans", res.Orphans,
				"bytes", res.Bytes, "errors", res.Errors, "duration", res.Duration)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Sweeper) now() time.Time {
	if s.Now == nil {
		return time.Now()
	}
	return s.Now()
}

// sweepMetrics are the sweeper's instruments (ouo.retention.*).
type sweepMetrics struct {
	runs     metric.Int64Counter
	sessions metric.Int64Counter
	bytes    metric.Int64Counter
	duration metric.Float64Histogram
	last     metric.Float64Gauge
}

func newSweepMetrics(mp metric.MeterProvider) sweepMetrics {
	if mp == nil {
		mp = otel.GetMeterProvider()
	}
	m := mp.Meter("github.com/ouo11y/ouo11y/services/rum-api/internal/lifecycle")
	runs, _ := m.Int64Counter("ouo.retention.sweeps", metric.WithDescription("Retention sweeper passes by result (ok, error)"), metric.WithUnit("{sweep}"))
	sessions, _ := m.Int64Counter("ouo.retention.sessions_deleted", metric.WithDescription("Replays deleted by the retention sweeper, by project and reason (expired, orphan)"), metric.WithUnit("{session}"))
	bytes, _ := m.Int64Counter("ouo.retention.bytes_deleted", metric.WithDescription("Stored replay bytes deleted by the retention sweeper, by project"), metric.WithUnit("By"))
	duration, _ := m.Float64Histogram("ouo.retention.sweep.duration", metric.WithDescription("Duration of one retention sweeper pass"), metric.WithUnit("s"))
	last, _ := m.Float64Gauge("ouo.retention.sweep.last_success", metric.WithDescription("Unix time of the last successful retention sweeper pass"), metric.WithUnit("s"))
	return sweepMetrics{runs: runs, sessions: sessions, bytes: bytes, duration: duration, last: last}
}

func (m sweepMetrics) deleted(ctx context.Context, project string, orphan bool, bytes int64) {
	reason := "expired"
	if orphan {
		reason = "orphan"
	}
	attrs := metric.WithAttributes(attribute.String("ouo.project.id", project), attribute.String("reason", reason))
	m.sessions.Add(ctx, 1, attrs)
	m.bytes.Add(ctx, bytes, metric.WithAttributes(attribute.String("ouo.project.id", project)))
}

func (m sweepMetrics) pass(ctx context.Context, res SweepResult, err error) {
	result := "ok"
	if err != nil {
		result = "error"
	} else {
		m.last.Record(ctx, float64(time.Now().Unix()))
	}
	m.runs.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
	m.duration.Record(ctx, res.Duration.Seconds())
}
