// Package erase deletes one user's or one project's RUM data across Loki, Tempo and
// Muninn, with an audit trail in Muninn (ADR-0026 section 5; Muninn spec sections 8 and
// 14). It is the library behind the ouo-erase CLI; a client backend that wants an erase
// button calls it the same way.
//
// The order is rum-api's: a started audit record first (if it cannot be written, nothing
// is deleted), the sessions from Loki over the log retention, the Tempo trace ids before
// anything is deleted, the replays in Muninn, a Loki delete request, then a completed or
// failed record under the same entry id with what each backend did.
package erase

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"time"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// Actions recorded in the audit record.
const (
	ActionDeleteUser    = "delete_user"
	ActionDeleteProject = "delete_project"
)

// Backend statuses in the audit record.
const (
	BackendDeleted     = "deleted"     // Muninn removed the data
	BackendSubmitted   = "submitted"   // Loki accepted the delete request
	BackendSkipped     = "skipped"     // not run: dry run, or switched off
	BackendFailed      = "failed"      // see Error
	BackendManual      = "manual"      // Tempo: redact the listed trace ids
	BackendUnsupported = "unsupported" // Tempo cannot delete a project's traces
	BackendNone        = "none"        // nothing found
)

// MaxSessionIDs bounds Record.Sessions (a project can have millions).
const MaxSessionIDs = 1000

// Record is one audit record, stored in Muninn under its entry id and status.
// Counts and backend results are set on the completed or failed record.
type Record struct {
	Entry  string    `json:"entry"`
	Time   time.Time `json:"time"`
	Status string    `json:"status"`
	// Action is delete_user or delete_project.
	Action    string `json:"action"`
	UserID    string `json:"user_id,omitempty"`
	ProjectID string `json:"project_id,omitempty"`
	Actor     string `json:"actor"`
	Reason    string `json:"reason,omitempty"`
	DryRun    bool   `json:"dry_run,omitempty"`
	// From and To are the time range searched (user) and given to the Loki delete request.
	From *time.Time `json:"from,omitempty"`
	To   *time.Time `json:"to,omitempty"`

	// SessionCount is the number of sessions found in Loki (user deletions); Sessions
	// lists them as project/session (the first MaxSessionIDs).
	SessionCount int      `json:"session_count"`
	Sessions     []string `json:"sessions,omitempty"`
	// Replays is what Muninn deleted (on a dry run, would delete; a project dry run cannot
	// count them). DebugFiles is set on project deletions.
	Replays    *Count   `json:"replays,omitempty"`
	DebugFiles *Count   `json:"debug_files,omitempty"`
	Muninn     *Backend `json:"muninn,omitempty"`
	Loki       *Backend `json:"loki,omitempty"`
	Tempo      *Backend `json:"tempo,omitempty"`
	Error      string   `json:"error,omitempty"`
	// Truncated: the stored record's Sessions or Tempo.TraceIDs were cut to fit Muninn's
	// 64 KiB record limit. The record Eraser returns (and ouo-erase prints) is complete.
	Truncated bool `json:"truncated,omitempty"`
}

// Count is a number of deleted objects, with their bytes when known.
type Count struct {
	Deleted int   `json:"deleted"`
	Bytes   int64 `json:"bytes,omitempty"`
}

// Backend is what one backend did with the deletion.
type Backend struct {
	Status   string   `json:"status"`
	Query    string   `json:"query,omitempty"`
	TraceIDs []string `json:"trace_ids,omitempty"`
	Note     string   `json:"note,omitempty"`
	Error    string   `json:"error,omitempty"`
}

// Request is one deletion. User: UserID, optionally only inside Project. Project:
// Project, and UserID is ignored.
type Request struct {
	UserID  string
	Project string
	Actor   string
	Reason  string
	DryRun  bool
}

// Eraser runs deletions. Loki and Muninn are required; Tempo is optional.
type Eraser struct {
	Loki *ouogo.Loki
	// LokiDeleteURL is the base of POST /loki/api/v1/delete (the compactor) when it
	// differs from Loki.URL.
	LokiDeleteURL string
	// LokiDelete submits Loki delete requests; false records Loki as skipped.
	LokiDelete bool
	// Tempo lists a user's trace ids (Tempo cannot delete by attribute: the ids go into
	// the record for `tempo-cli redact`, or expire with the trace retention); nil
	// records Tempo as skipped.
	Tempo  *ouogo.Tempo
	Muninn *ouogo.Muninn
	// LogRetention bounds the session lookup and the Loki delete window (default 720h).
	LogRetention time.Duration
	// MaxSessionDuration widens each session's trace search window (default 4h).
	MaxSessionDuration time.Duration
	// Now and Rand make the entry id and the record times; time.Now and crypto/rand when nil.
	Now  func() time.Time
	Rand io.Reader
}

// ErrAudit wraps a failure to write the started record: nothing was deleted.
var ErrAudit = errors.New("audit record not written, nothing deleted")

var (
	reProject = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	reSession = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

func (e *Eraser) now() time.Time {
	if e.Now != nil {
		return e.Now().UTC()
	}
	return time.Now().UTC()
}

func (e *Eraser) retention() time.Duration {
	if e.LogRetention > 0 {
		return e.LogRetention
	}
	return 720 * time.Hour
}

// lokiStart is the start of a Loki delete request ending at to: the log retention plus a
// day of slack. Loki refuses a zero start and splits a request into 24h shards, so an
// epoch start would mean some twenty thousand shards; nothing older is left anyway.
func (e *Eraser) lokiStart(to time.Time) time.Time {
	return to.Add(-e.retention() - 24*time.Hour)
}

// NewEntryID returns an audit entry id for t: its UTC time, then 8 random hex digits.
func NewEntryID(t time.Time, r io.Reader) (string, error) {
	if r == nil {
		r = rand.Reader
	}
	b := make([]byte, 4)
	if _, err := io.ReadFull(r, b); err != nil {
		return "", err
	}
	return t.UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b), nil
}

func (e *Eraser) begin(ctx context.Context, action string, req Request) (*Record, error) {
	now := e.now()
	id, err := NewEntryID(now, e.Rand)
	if err != nil {
		return nil, fmt.Errorf("%w: entry id: %v", ErrAudit, err)
	}
	r := &Record{Entry: id, Time: now, Status: ouogo.AuditStarted, Action: action,
		UserID: req.UserID, ProjectID: req.Project, Actor: req.Actor, Reason: req.Reason, DryRun: req.DryRun}
	if err := e.Muninn.PutAudit(ctx, id, ouogo.AuditStarted, r); err != nil {
		return r, fmt.Errorf("%w: %w", ErrAudit, err)
	}
	return r, nil
}

// finish writes the completed or failed record. The work is done whatever the context
// says, so the record is written with a fresh deadline.
func (e *Eraser) finish(ctx context.Context, r *Record, failure error) (*Record, error) {
	r.Time = e.now()
	r.Status = ouogo.AuditCompleted
	if failure != nil {
		r.Status, r.Error = ouogo.AuditFailed, failure.Error()
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := e.Muninn.PutAudit(ctx, r.Entry, r.Status, fit(r)); err != nil {
		failure = errors.Join(failure, fmt.Errorf("audit %s record: %w", r.Status, err))
	}
	return r, failure
}

// fit returns r, or a copy with Sessions and then Tempo.TraceIDs cut until it marshals to
// at most ouogo.MaxAuditRecord bytes.
func fit(r *Record) *Record {
	size := func(x *Record) int { b, _ := json.Marshal(x); return len(b) }
	if size(r) <= ouogo.MaxAuditRecord {
		return r
	}
	c := *r
	c.Truncated = true
	if c.Tempo != nil {
		t := *c.Tempo
		c.Tempo = &t
	}
	for size(&c) > ouogo.MaxAuditRecord && len(c.Sessions) > 0 {
		c.Sessions = c.Sessions[:len(c.Sessions)/2]
	}
	for size(&c) > ouogo.MaxAuditRecord && c.Tempo != nil && len(c.Tempo.TraceIDs) > 0 {
		c.Tempo.TraceIDs = c.Tempo.TraceIDs[:len(c.Tempo.TraceIDs)/2]
	}
	return &c
}

// User deletes one user's replays and Loki lines and lists their trace ids for Tempo
// redaction. Sessions are found in Loki (enduser_id / user_id) over the log retention.
// The returned record is the final one; the error is ErrAudit (nothing deleted), or what
// failed, with the record saying what the other backends did.
func (e *Eraser) User(ctx context.Context, req Request) (*Record, error) {
	if req.UserID == "" {
		return nil, errors.New("user id is required")
	}
	if req.Project != "" && !reProject.MatchString(req.Project) {
		return nil, errors.New("project must match ^[a-z0-9][a-z0-9._-]{0,63}$")
	}
	r, err := e.begin(ctx, ActionDeleteUser, req)
	if err != nil {
		return r, err
	}
	to := r.Time
	from := to.Add(-e.retention())
	r.From, r.To = &from, &to
	query := subjectFilter(req.UserID, req.Project)

	found, err := sessions(ctx, e.Loki, query, from, to)
	if err != nil {
		r.Loki = &Backend{Status: BackendFailed, Query: query, Error: "session lookup: " + err.Error()}
		return e.finish(ctx, r, fmt.Errorf("find sessions in loki: %w", err))
	}
	setSessions(r, found)

	// Trace ids before anything is deleted.
	r.Tempo = e.traceIDs(ctx, found)

	var errs []error
	r.Replays, r.Muninn, errs = e.userReplays(ctx, found, req.DryRun)
	if r.Tempo.Status == BackendFailed {
		errs = append(errs, errors.New("tempo: "+r.Tempo.Error))
	}
	r.Loki = e.lokiDelete(ctx, query, to, req.DryRun)
	if r.Loki.Status == BackendFailed {
		errs = append(errs, errors.New("loki: "+r.Loki.Error))
	}
	return e.finish(ctx, r, errors.Join(errs...))
}

func (e *Eraser) userReplays(ctx context.Context, found []sessionRef, dryRun bool) (*Count, *Backend, []error) {
	c := &Count{}
	var errs []error
	for _, s := range found {
		if !reSession.MatchString(s.ID) || !reProject.MatchString(s.Project) {
			continue // Muninn takes no other ids (MUN-5), so it holds no replay of this one
		}
		list, err := e.Muninn.ListReplays(ctx, s.Project, s.ID)
		if err != nil {
			errs = append(errs, fmt.Errorf("muninn: list replays %s/%s: %w", s.Project, s.ID, err))
			continue
		}
		if !dryRun {
			if err := e.Muninn.DeleteSessionReplays(ctx, s.Project, s.ID); err != nil {
				errs = append(errs, fmt.Errorf("muninn: delete replays %s/%s: %w", s.Project, s.ID, err))
				continue
			}
		}
		for _, rp := range list {
			c.Deleted++
			c.Bytes += rp.ByteSize
		}
	}
	b := &Backend{Status: BackendDeleted}
	switch {
	case len(errs) > 0:
		b.Status, b.Error = BackendFailed, errors.Join(errs...).Error()
	case dryRun:
		b.Status, b.Note = BackendSkipped, "dry run: replays counts what would be deleted"
	case c.Deleted == 0:
		b.Status = BackendNone
	}
	return c, b, errs
}

// Project deletes every replay and debug file of the project in Muninn and its Loki
// lines. Tempo cannot delete by attribute: the project's traces expire with the trace
// retention.
func (e *Eraser) Project(ctx context.Context, req Request) (*Record, error) {
	if !reProject.MatchString(req.Project) {
		return nil, errors.New("project must match ^[a-z0-9][a-z0-9._-]{0,63}$")
	}
	req.UserID = ""
	r, err := e.begin(ctx, ActionDeleteProject, req)
	if err != nil {
		return r, err
	}
	to := r.Time
	from := e.lokiStart(to)
	r.From, r.To = &from, &to
	r.Tempo = &Backend{Status: BackendUnsupported,
		Note: "Tempo redacts by trace id only; the project's traces expire with the trace retention (docs/operations/data-lifecycle.md)"}

	var errs []error
	switch {
	case req.DryRun:
		r.Muninn = &Backend{Status: BackendSkipped,
			Note: "dry run: Muninn would delete every replay and debug file of the project; it counts them only when it deletes"}
	default:
		counts, err := e.Muninn.DeleteProject(ctx, req.Project)
		if err != nil {
			r.Muninn = &Backend{Status: BackendFailed, Error: err.Error()}
			errs = append(errs, fmt.Errorf("muninn: %w", err))
			break
		}
		r.Muninn = &Backend{Status: BackendDeleted}
		r.Replays = &Count{Deleted: counts.Replays}
		r.DebugFiles = &Count{Deleted: counts.DebugFiles}
	}
	r.Loki = e.lokiDelete(ctx, subjectFilter("", req.Project), to, req.DryRun)
	if r.Loki.Status == BackendFailed {
		errs = append(errs, errors.New("loki: "+r.Loki.Error))
	}
	return e.finish(ctx, r, errors.Join(errs...))
}

func setSessions(r *Record, found []sessionRef) {
	r.SessionCount = len(found)
	for i, s := range found {
		if i == MaxSessionIDs {
			break
		}
		r.Sessions = append(r.Sessions, s.Project+"/"+s.ID)
	}
}

func (e *Eraser) lokiDelete(ctx context.Context, query string, to time.Time, dryRun bool) *Backend {
	b := &Backend{Query: query}
	switch {
	case !e.LokiDelete:
		b.Status, b.Note = BackendSkipped, "Loki delete requests are switched off (--loki-delete=false)"
	case dryRun:
		b.Status, b.Note = BackendSkipped, "dry run"
	default:
		base := e.LokiDeleteURL
		if base == "" {
			base = e.Loki.URL
		}
		if err := lokiDelete(ctx, e.Loki, base, query, e.lokiStart(to), to, e.now()); err != nil {
			b.Status, b.Error = BackendFailed, err.Error()
		} else {
			b.Status = BackendSubmitted
			b.Note = "lines are hidden once the compactor picks the request up (after compactor.delete_request_cancel_period) and removed from chunks by the next compaction"
		}
	}
	return b
}

// traceIDs lists the sessions' traces for `tempo-cli redact`.
func (e *Eraser) traceIDs(ctx context.Context, found []sessionRef) *Backend {
	b := &Backend{}
	if e.Tempo == nil {
		b.Status, b.Note = BackendSkipped, "no Tempo URL given"
		return b
	}
	maxSession := e.MaxSessionDuration
	if maxSession <= 0 {
		maxSession = 4 * time.Hour
	}
	set := map[string]bool{}
	var errs []error
	for _, s := range found {
		if !reSession.MatchString(s.ID) {
			continue // every SDK and the Sentry bridge send 32 hex; Tempo is searched by those only
		}
		end := s.Seen.Add(time.Hour)
		start := s.Seen.Add(-sessionWindow - maxSession)
		ids, err := e.Tempo.TraceIDs(ctx, s.ID, ouogo.TimeRange{From: start, To: end})
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, id := range ids {
			set[id] = true
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
