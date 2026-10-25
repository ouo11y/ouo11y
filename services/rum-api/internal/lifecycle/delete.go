package lifecycle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/audit"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/loki"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/tempo"
)

// Actions recorded in the audit log.
const (
	ActionDeleteUser    = "delete_user"
	ActionDeleteProject = "delete_project"
)

// Backend statuses in the audit entry.
const (
	BackendSubmitted   = "submitted"
	BackendSkipped     = "skipped"
	BackendFailed      = "failed"
	BackendManual      = "manual"
	BackendUnsupported = "unsupported"
	BackendNone        = "none"
)

// DeleteStore is what deletions need from the replay store.
type DeleteStore interface {
	replay.Lister
	Meta(ctx context.Context, sessionID string) (replay.Meta, error)
	Delete(ctx context.Context, sessionID string) error
}

// LogBackend is Loki: the session lookup and the delete API.
type LogBackend interface {
	SessionIDs(ctx context.Context, query string, start, end time.Time) (map[string]time.Time, error)
	Delete(ctx context.Context, query string, start, end time.Time) error
}

// TraceBackend lists a session's traces (Tempo).
type TraceBackend interface {
	SessionTraces(ctx context.Context, sessionID string, start, end time.Time) ([]tempo.Trace, error)
}

// Deleter runs delete-by-user and delete-by-project: replays first (the
// store rum-api owns), then a Loki delete request, then the Tempo trace ids
// for redaction, with a started and a completed / failed audit entry.
type Deleter struct {
	Store  DeleteStore
	Audit  audit.Log
	Logs   LogBackend
	Traces TraceBackend
	// SourceMaps, when set, also loses a deleted project's source maps.
	SourceMaps SourceMapStore
	// LokiDeletes submits Loki delete requests (loki.delete_api).
	LokiDeletes bool
	// LogRetention bounds the session lookup of a user deletion.
	LogRetention time.Duration
	// MaxSessionDuration widens each session's trace search window.
	MaxSessionDuration time.Duration
	Now                func() time.Time
	metrics            deleteMetrics
}

// SourceMapStore is the source-map store's part in delete-by-project
// (sourcemap.Store).
type SourceMapStore interface {
	// CountProject returns how many maps the project has.
	CountProject(ctx context.Context, projectID string) (int, error)
	DeleteProject(ctx context.Context, projectID string) (int, error)
}

// NewDeleter wires the metrics on mp (the global provider when nil).
func NewDeleter(d Deleter, mp metric.MeterProvider) *Deleter {
	d.metrics = newDeleteMetrics(mp)
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.LogRetention <= 0 {
		d.LogRetention = 720 * time.Hour
	}
	if d.MaxSessionDuration <= 0 {
		d.MaxSessionDuration = 4 * time.Hour
	}
	return &d
}

// Request is one deletion. UserID set: delete that user (within ProjectID
// when set). Otherwise ProjectID: delete the whole project.
type Request struct {
	UserID    string
	ProjectID string
	Actor     string
	Reason    string
	DryRun    bool
}

// ErrAudit wraps a failure to write the started entry: nothing was deleted.
var ErrAudit = errors.New("audit log unavailable")

// lokiStart is the start of a Loki delete request ending at `to`: the log
// retention plus a day of slack. Loki refuses a zero start, and splits a
// request into delete_max_interval (24h) shards, so an epoch start would mean
// some twenty thousand shards; nothing older than the retention is left anyway.
func (d *Deleter) lokiStart(to time.Time) time.Time {
	return to.Add(-d.LogRetention - 24*time.Hour)
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (d *Deleter) begin(ctx context.Context, action string, req Request) (audit.Entry, error) {
	now := d.Now().UTC()
	e := audit.Entry{ID: newID(), Time: now, Status: audit.StatusStarted, Action: action,
		UserID: req.UserID, ProjectID: req.ProjectID, Actor: req.Actor, Reason: req.Reason, DryRun: req.DryRun}
	if err := d.Audit.Append(ctx, e); err != nil {
		return e, fmt.Errorf("%w: %v", ErrAudit, err)
	}
	return e, nil
}

// finish writes the completed / failed entry. The work is done whatever the
// context says, so the entry is written with a fresh deadline.
func (d *Deleter) finish(e audit.Entry, failure error) (audit.Entry, error) {
	e.Time = d.Now().UTC()
	e.Status = audit.StatusCompleted
	if failure != nil {
		e.Status, e.Error = audit.StatusFailed, failure.Error()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.Audit.Append(ctx, e); err != nil {
		slog.Error("audit: completed entry not written", "id", e.ID, "action", e.Action, "error", err)
		failure = errors.Join(failure, fmt.Errorf("audit: %w", err))
	}
	d.metrics.done(ctx, e)
	return e, failure
}

// DeleteUser deletes one user's replays and Loki lines (and lists their
// traces for Tempo redaction). Sessions are found through Loki (user_id
// structured metadata) over the log retention.
func (d *Deleter) DeleteUser(ctx context.Context, req Request) (audit.Entry, error) {
	if req.UserID == "" {
		return audit.Entry{}, errors.New("user id is required")
	}
	e, err := d.begin(ctx, ActionDeleteUser, req)
	if err != nil {
		return e, err
	}
	to := e.Time
	from := to.Add(-d.LogRetention)
	e.From, e.To = &from, &to
	query := loki.SubjectFilter(req.UserID, req.ProjectID)

	found, err := d.Logs.SessionIDs(ctx, query, from, to)
	if err != nil {
		return d.finish(e, fmt.Errorf("find sessions in loki: %w", err))
	}
	ids := make([]string, 0, len(found))
	for id := range found {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	// Trace ids before anything is deleted: the lookup goes through Loki's
	// session window and Tempo's session.id attribute.
	e.Tempo = d.traceIDs(ctx, ids, found)

	var errs []error
	e.Replays = &audit.Replays{}
	kept := ids[:0]
	for _, id := range ids {
		m, err := d.Store.Meta(ctx, id)
		if err != nil && !errors.Is(err, replay.ErrNotFound) {
			errs = append(errs, fmt.Errorf("replay %s: %w", id, err))
			kept = append(kept, id)
			continue
		}
		if err == nil && req.ProjectID != "" && m.ProjectID != "" && m.ProjectID != req.ProjectID {
			continue // same user id in another project
		}
		kept = append(kept, id)
		if err != nil {
			continue // no replay for this session
		}
		if !req.DryRun {
			if err := d.Store.Delete(ctx, id); err != nil {
				errs = append(errs, fmt.Errorf("delete replay %s: %w", id, err))
				continue
			}
		}
		e.Replays.Deleted++
		e.Replays.Bytes += m.Bytes
	}
	setSessions(&e, kept)
	e.Loki = d.lokiDelete(ctx, query, to, req.DryRun)
	if e.Loki.Status == BackendFailed {
		errs = append(errs, errors.New("loki: "+e.Loki.Error))
	}
	return d.finish(e, errors.Join(errs...))
}

// DeleteProject deletes every replay recorded under the project and its
// Loki lines. Tempo cannot delete by attribute in 3.0 (see the entry's note).
func (d *Deleter) DeleteProject(ctx context.Context, req Request) (audit.Entry, error) {
	if req.ProjectID == "" {
		return audit.Entry{}, errors.New("project id is required")
	}
	req.UserID = ""
	e, err := d.begin(ctx, ActionDeleteProject, req)
	if err != nil {
		return e, err
	}
	to := e.Time
	from := d.lokiStart(to)
	e.From, e.To = &from, &to
	var errs []error
	var ids []string
	e.Replays = &audit.Replays{}
	err = d.Store.Sessions(ctx, func(s replay.SessionEntry) error {
		if s.Meta == nil || s.Meta.ProjectID != req.ProjectID {
			return nil
		}
		ids = append(ids, s.ID)
		if !req.DryRun {
			if err := d.Store.Delete(ctx, s.ID); err != nil {
				errs = append(errs, fmt.Errorf("delete replay %s: %w", s.ID, err))
				return nil
			}
		}
		e.Replays.Deleted++
		e.Replays.Bytes += s.Meta.Bytes
		return nil
	})
	if err != nil {
		errs = append(errs, fmt.Errorf("list replays: %w", err))
	}
	sort.Strings(ids)
	setSessions(&e, ids)
	if d.SourceMaps != nil {
		e.SourceMaps = &audit.SourceMaps{}
		var n int
		var err error
		if req.DryRun {
			n, err = d.SourceMaps.CountProject(ctx, req.ProjectID)
		} else {
			n, err = d.SourceMaps.DeleteProject(ctx, req.ProjectID)
		}
		e.SourceMaps.Deleted = n
		if err != nil {
			errs = append(errs, fmt.Errorf("delete source maps: %w", err))
		}
	}
	query := loki.SubjectFilter("", req.ProjectID)
	e.Loki = d.lokiDelete(ctx, query, to, req.DryRun)
	if e.Loki.Status == BackendFailed {
		errs = append(errs, errors.New("loki: "+e.Loki.Error))
	}
	e.Tempo = &audit.Backend{Status: BackendUnsupported,
		Note: "Tempo 3.0 redacts by trace id only; the project's traces expire with the trace retention (docs/operations/data-lifecycle.md)"}
	return d.finish(e, errors.Join(errs...))
}

func setSessions(e *audit.Entry, ids []string) {
	e.SessionCount = len(ids)
	if len(ids) > audit.MaxSessionIDs {
		ids = ids[:audit.MaxSessionIDs]
	}
	e.Sessions = append([]string(nil), ids...)
}

func (d *Deleter) lokiDelete(ctx context.Context, query string, to time.Time, dryRun bool) *audit.Backend {
	b := &audit.Backend{Query: query}
	switch {
	case !d.LokiDeletes:
		b.Status, b.Note = BackendSkipped, "loki.delete_api is false"
	case dryRun:
		b.Status, b.Note = BackendSkipped, "dry run"
	default:
		if err := d.Logs.Delete(ctx, query, d.lokiStart(to), to); err != nil {
			b.Status, b.Error = BackendFailed, err.Error()
		} else {
			b.Status = BackendSubmitted
			b.Note = "lines are hidden once the compactor picks the request up (after compactor.delete_request_cancel_period) and removed from chunks by the next compaction"
		}
	}
	return b
}

// traceIDs lists the traces of the sessions for `tempo-cli redact`.
func (d *Deleter) traceIDs(ctx context.Context, ids []string, seen map[string]time.Time) *audit.Backend {
	b := &audit.Backend{}
	if d.Traces == nil {
		b.Status, b.Note = BackendSkipped, "no tempo client"
		return b
	}
	set := map[string]bool{}
	var errs []error
	for _, id := range ids {
		end := seen[id].Add(time.Hour)
		start := seen[id].Add(-24*time.Hour - d.MaxSessionDuration)
		traces, err := d.Traces.SessionTraces(ctx, id, start, end)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, t := range traces {
			set[t.TraceID] = true
		}
	}
	for id := range set {
		b.TraceIDs = append(b.TraceIDs, id)
	}
	sort.Strings(b.TraceIDs)
	switch {
	case len(errs) > 0:
		b.Status, b.Error = BackendFailed, errors.Join(errs...).Error()
	case len(b.TraceIDs) == 0:
		b.Status = BackendNone
	default:
		b.Status = BackendManual
		b.Note = "Tempo has no delete API: run `tempo-cli redact --tenant=<tenant> --trace-id=<id>... <backend-scheduler:9095>` with these ids, or let the trace retention expire them (docs/operations/data-lifecycle.md)"
	}
	return b
}

type deleteMetrics struct {
	deletions metric.Int64Counter
	replays   metric.Int64Counter
}

func newDeleteMetrics(mp metric.MeterProvider) deleteMetrics {
	if mp == nil {
		mp = otel.GetMeterProvider()
	}
	m := mp.Meter("github.com/ouo11y/ouo11y/services/rum-api/internal/lifecycle")
	deletions, _ := m.Int64Counter("ouo.deletions", metric.WithDescription("Delete-by-user and delete-by-project requests by action and status"), metric.WithUnit("{deletion}"))
	replays, _ := m.Int64Counter("ouo.deletions.replays", metric.WithDescription("Replays deleted by delete-by-user and delete-by-project"), metric.WithUnit("{session}"))
	return deleteMetrics{deletions: deletions, replays: replays}
}

func (m deleteMetrics) done(ctx context.Context, e audit.Entry) {
	attrs := metric.WithAttributes(attribute.String("action", e.Action), attribute.String("status", e.Status), attribute.Bool("dry_run", e.DryRun))
	m.deletions.Add(ctx, 1, attrs)
	if e.Replays != nil && !e.DryRun {
		m.replays.Add(ctx, int64(e.Replays.Deleted), metric.WithAttributes(attribute.String("action", e.Action)))
	}
}
