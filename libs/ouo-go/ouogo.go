// Package ouogo reads ouo's RUM data (the client SDK spec's wire in Loki, replays in Muninn)
// as plain typed functions, and applies Clearance to every result before it is returned
// (ADR-0023). Every read function takes the caller's Clearance; there is no variant without.
package ouogo

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Client holds the stores ouogo reads.
type Client struct {
	Loki   *Loki
	Muninn *Muninn
	// ListLimit bounds the Loki records a session list reads (default 5000, Loki's default
	// max_entries_limit_per_query). A list that hit it says Truncated.
	ListLimit int
	// EventLimit bounds the events of one session (default 5000).
	EventLimit int
	// Now is for tests; time.Now when nil.
	Now func() time.Time
}

// Errors a caller maps to HTTP statuses.
var (
	ErrForbidden = errors.New("clearance too low")
	ErrNotFound  = errors.New("not found")
)

// BadRequestError is an invalid identifier or parameter.
type BadRequestError struct{ Msg string }

func (e *BadRequestError) Error() string { return e.Msg }

// BackendError is a failure of Loki or Muninn.
type BackendError struct {
	Backend string
	Err     error
}

func (e *BackendError) Error() string { return e.Backend + ": " + e.Err.Error() }
func (e *BackendError) Unwrap() error { return e.Err }

var (
	reHex32   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	reProject = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
)

func checkID(kind, v string) error {
	if !reHex32.MatchString(v) {
		return &BadRequestError{Msg: fmt.Sprintf("%s must be 32 lowercase hex characters", kind)}
	}
	return nil
}

func checkProject(v string) error {
	if !reProject.MatchString(v) {
		return &BadRequestError{Msg: "project must match ^[a-z0-9][a-z0-9._-]{0,63}$"}
	}
	return nil
}

// TimeRange is a closed query window. Zero values mean the last 24 hours.
type TimeRange struct {
	From, To time.Time
}

func (c *Client) window(r TimeRange) (time.Time, time.Time, error) {
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	to := r.To
	if to.IsZero() {
		to = now()
	}
	from := r.From
	if from.IsZero() {
		from = to.Add(-24 * time.Hour)
	}
	if !from.Before(to) {
		return time.Time{}, time.Time{}, &BadRequestError{Msg: "from must be before to"}
	}
	if to.Sub(from) > 30*24*time.Hour {
		return time.Time{}, time.Time{}, &BadRequestError{Msg: "time range longer than 30 days"}
	}
	return from, to, nil
}

func orDefault(n, d int) int {
	if n > 0 {
		return n
	}
	return d
}

// Session is one session as listed. User is set only with Identity clearance.
type Session struct {
	Project    string `json:"project"`
	ID         string `json:"id"`
	Service    string `json:"service"`
	Start      int64  `json:"start"`
	End        int64  `json:"end"`
	EventCount int    `json:"event_count"`
	ErrorCount int    `json:"error_count"`
	// HasReplay is a hint from Loki's reference records; Muninn is the authority (RDR-1).
	HasReplay bool   `json:"has_replay"`
	User      string `json:"user,omitempty"`
}

// SessionList is the answer of ListSessions.
type SessionList struct {
	Sessions  []Session `json:"sessions"`
	Truncated bool      `json:"truncated"`
	Redacted  []string  `json:"redacted"`
}

// Event is one record of a session's timeline. Attributes and Body need Attributes
// clearance; identity attributes need Identity clearance.
type Event struct {
	Time       int64             `json:"time"`
	Name       string            `json:"name"`
	Severity   string            `json:"severity,omitempty"`
	ViewID     string            `json:"view_id,omitempty"`
	TraceID    string            `json:"trace_id,omitempty"`
	SpanID     string            `json:"span_id,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
	Body       string            `json:"body,omitempty"`
}

// SessionDetail is the answer of GetSession. Replays is nil without Replay clearance.
type SessionDetail struct {
	Session Session         `json:"session"`
	Events  []Event         `json:"events"`
	Replays []ReplaySummary `json:"replays"`
	// ReplaysError is set when Muninn could not be read; the timeline is still answered.
	ReplaysError string   `json:"replays_error,omitempty"`
	Redacted     []string `json:"redacted"`
}

// SessionQuery filters ListSessions.
type SessionQuery struct {
	TimeRange
	Project string // empty: every project
	Limit   int    // sessions returned, default 200
}

// Replay chunk references are telemetry about telemetry; the timeline leaves them out.
const replaySelector = `event_name!~"ouo[.]replay[.]chunk"`

// sessionAgg accumulates one session's summary from its records.
type sessionAgg struct {
	Session
	user string
}

func (a *sessionAgg) add(l lokiLine) {
	ms := l.Time.UnixMilli()
	if a.Start == 0 || ms < a.Start {
		a.Start = ms
	}
	if ms > a.End {
		a.End = ms
	}
	a.EventCount++
	if isError(l.Labels) {
		a.ErrorCount++
	}
	if a.Service == "" {
		a.Service = l.Labels["service_name"]
	}
	if u := l.Labels["enduser_id"]; u != "" {
		a.user = u
	}
}

func isError(labels map[string]string) bool {
	if labels["event_name"] == "exception" || labels["event_name"] == "app.crash" {
		return true
	}
	switch strings.ToUpper(labels["severity_text"]) {
	case "ERROR", "FATAL":
		return true
	}
	return false
}

// session returns the summary this clearance may see.
func (c Clearance) session(a *sessionAgg) Session {
	s := a.Session
	s.User = ""
	if c.Can().Identity {
		s.User = a.user
	}
	return s
}

// ListSessions lists the sessions that have records in the range, newest first. It reads
// at most ListLimit records (newest first) and groups them by session, so with heavy
// traffic the oldest sessions of the range may be missing or undercounted: Truncated says so.
func (c *Client) ListSessions(ctx context.Context, cl Clearance, q SessionQuery) (*SessionList, error) {
	if !cl.Can().Timeline {
		return nil, ErrForbidden
	}
	from, to, err := c.window(q.TimeRange)
	if err != nil {
		return nil, err
	}
	project := `=~".+"`
	if q.Project != "" {
		if err := checkProject(q.Project); err != nil {
			return nil, err
		}
		project = `="` + q.Project + `"`
	}
	limit := orDefault(c.ListLimit, 5000)
	logql := `{ouo_project_id` + project + `, ` + replaySelector + `} | session_id != ""`
	lines, err := c.Loki.queryRange(ctx, logql, from, to, limit, true)
	if err != nil {
		return nil, err
	}
	aggs := map[[2]string]*sessionAgg{}
	for _, l := range lines {
		k := [2]string{l.Labels["ouo_project_id"], l.Labels["session_id"]}
		a := aggs[k]
		if a == nil {
			a = &sessionAgg{Session: Session{Project: k[0], ID: k[1]}}
			aggs[k] = a
		}
		a.add(l)
	}
	// Replay hint: sessions with chunk reference records in the range.
	hint := `sum by (ouo_project_id, session_id) (count_over_time({ouo_project_id` + project +
		`, event_name="ouo.replay.chunk"} [` + fmt.Sprintf("%ds", int(to.Sub(from).Seconds())) + `]))`
	if series, _, err := c.Loki.queryVector(ctx, hint, to); err == nil {
		for _, m := range series {
			if a := aggs[[2]string{m["ouo_project_id"], m["session_id"]}]; a != nil {
				a.HasReplay = true
			}
		}
	}
	out := &SessionList{Sessions: []Session{}, Truncated: len(lines) >= limit, Redacted: cl.redactedGroups()}
	for _, a := range aggs {
		out.Sessions = append(out.Sessions, cl.session(a))
	}
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].End > out.Sessions[j].End })
	if n := orDefault(q.Limit, 200); len(out.Sessions) > n {
		out.Sessions = out.Sessions[:n]
		out.Truncated = true
	}
	return out, nil
}

// GetSession returns one session's summary, its event timeline and, with Replay clearance,
// its replays from Muninn. ErrNotFound when Loki has no record of it in the range.
func (c *Client) GetSession(ctx context.Context, cl Clearance, project, session string, r TimeRange) (*SessionDetail, error) {
	if !cl.Can().Timeline {
		return nil, ErrForbidden
	}
	if err := checkProject(project); err != nil {
		return nil, err
	}
	if err := checkID("session", session); err != nil {
		return nil, err
	}
	from, to, err := c.window(r)
	if err != nil {
		return nil, err
	}
	logql := `{ouo_project_id="` + project + `", ` + replaySelector + `} | session_id="` + session + `"`
	lines, err := c.Loki.queryRange(ctx, logql, from, to, orDefault(c.EventLimit, 5000), false)
	if err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		return nil, ErrNotFound
	}
	agg := &sessionAgg{Session: Session{Project: project, ID: session}}
	out := &SessionDetail{Events: make([]Event, 0, len(lines)), Redacted: cl.redactedGroups()}
	for _, l := range lines {
		agg.add(l)
		out.Events = append(out.Events, cl.event(l))
	}
	if cl.Can().Replay {
		replays, err := c.Muninn.listReplays(ctx, project, session)
		if err != nil {
			out.ReplaysError = err.Error()
		} else {
			out.Replays = replays
			agg.HasReplay = len(replays) > 0
		}
	}
	out.Session = cl.session(agg)
	return out, nil
}

// event returns the timeline entry this clearance may see.
func (c Clearance) event(l lokiLine) Event {
	e := Event{
		Time:     l.Time.UnixMilli(),
		Name:     l.Labels["event_name"],
		Severity: l.Labels["severity_text"],
		ViewID:   l.Labels["ouo_view_id"],
		TraceID:  l.Labels["trace_id"],
		SpanID:   l.Labels["span_id"],
	}
	if e.Name == "" {
		e.Name = "log"
	}
	e.Attributes = c.attributes(l.Labels)
	if c.Can().Attributes {
		e.Body = l.Body
	}
	return e
}

// GetManifest returns one replay's manifest. Needs Replay clearance.
func (c *Client) GetManifest(ctx context.Context, cl Clearance, project, session, replay string) (*Manifest, error) {
	if !cl.Can().Replay {
		return nil, ErrForbidden
	}
	if err := checkReplayIDs(project, session, replay); err != nil {
		return nil, err
	}
	return c.Muninn.manifest(ctx, project, session, replay)
}

// GetChunk returns one chunk's bytes, decompressed. Needs Replay clearance.
func (c *Client) GetChunk(ctx context.Context, cl Clearance, project, session, replay, stream string, seq int64) (*ChunkBytes, error) {
	if !cl.Can().Replay {
		return nil, ErrForbidden
	}
	if err := checkReplayIDs(project, session, replay); err != nil {
		return nil, err
	}
	if err := checkID("stream", stream); err != nil {
		return nil, err
	}
	if seq < 0 || seq > 999_999_999 {
		return nil, &BadRequestError{Msg: "sequence out of range"}
	}
	return c.Muninn.chunk(ctx, project, session, replay, stream, seq)
}

func checkReplayIDs(project, session, replay string) error {
	if err := checkProject(project); err != nil {
		return err
	}
	if err := checkID("session", session); err != nil {
		return err
	}
	return checkID("replay", replay)
}
