package ouogo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Loki reads the spec wire from Loki's HTTP API. Attributes come back as labels with "."
// written "_": the deployment promotes a few resource attributes and event.name to stream
// labels and keeps the rest as structured metadata, which Loki merges into the stream
// labels of a query answer.
type Loki struct {
	URL  string // base URL, e.g. http://loki:3100
	HTTP *http.Client
	// OrgID is sent as X-Scope-OrgID when set (Loki with auth_enabled).
	OrgID string
	// ListLimit bounds the records ListSessions reads (default 5000, Loki's default
	// max_entries_limit_per_query). A list that hit it says Truncated.
	ListLimit int
	// EventLimit bounds the events SessionEvents reads (default 5000).
	EventLimit int
	// Now is the clock for default time ranges; time.Now when nil.
	Now func() time.Time
}

// LokiLine is one log line of a query answer: its stream labels merged with its
// structured metadata.
type LokiLine struct {
	Time   time.Time
	Labels map[string]string
	Body   string
}

type lokiAnswer struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string          `json:"resultType"`
		Result     json.RawMessage `json:"result"`
	} `json:"data"`
}

func (l *Loki) get(ctx context.Context, path string, q url.Values) (*lokiAnswer, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, l.URL+path+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if l.OrgID != "" {
		req.Header.Set("X-Scope-OrgID", l.OrgID)
	}
	c := l.HTTP
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, &BackendError{Backend: "loki", Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return nil, &BackendError{Backend: "loki", Err: err}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("%s: %s", resp.Status, truncate(string(body), 300))}
	}
	var a lokiAnswer
	if err := json.Unmarshal(body, &a); err != nil {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("decode: %w", err)}
	}
	return &a, nil
}

// QueryRange runs a log query and returns its lines, oldest first. The query is sent as
// given: build it only from validated values.
func (l *Loki) QueryRange(ctx context.Context, logql string, from, to time.Time, limit int, backward bool) ([]LokiLine, error) {
	dir := "forward"
	if backward {
		dir = "backward"
	}
	q := url.Values{
		"query":     {logql},
		"start":     {strconv.FormatInt(from.UnixNano(), 10)},
		"end":       {strconv.FormatInt(to.UnixNano(), 10)},
		"limit":     {strconv.Itoa(limit)},
		"direction": {dir},
	}
	a, err := l.get(ctx, "/loki/api/v1/query_range", q)
	if err != nil {
		return nil, err
	}
	if a.Data.ResultType != "streams" {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("want streams, got %q", a.Data.ResultType)}
	}
	var streams []struct {
		Stream map[string]string `json:"stream"`
		Values [][2]string       `json:"values"`
	}
	if err := json.Unmarshal(a.Data.Result, &streams); err != nil {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("decode streams: %w", err)}
	}
	var out []LokiLine
	for _, s := range streams {
		for _, v := range s.Values {
			ns, err := strconv.ParseInt(v[0], 10, 64)
			if err != nil {
				continue
			}
			out = append(out, LokiLine{Time: time.Unix(0, ns), Labels: s.Stream, Body: v[1]})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time.Before(out[j].Time) })
	return out, nil
}

// QueryVector runs an instant metric query and returns each series' labels.
func (l *Loki) QueryVector(ctx context.Context, logql string, at time.Time) ([]map[string]string, error) {
	q := url.Values{"query": {logql}, "time": {strconv.FormatInt(at.UnixNano(), 10)}}
	a, err := l.get(ctx, "/loki/api/v1/query", q)
	if err != nil {
		return nil, err
	}
	if a.Data.ResultType != "vector" {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("want vector, got %q", a.Data.ResultType)}
	}
	var series []struct {
		Metric map[string]string `json:"metric"`
	}
	if err := json.Unmarshal(a.Data.Result, &series); err != nil {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("decode vector: %w", err)}
	}
	labels := make([]map[string]string, 0, len(series))
	for _, s := range series {
		labels = append(labels, s.Metric)
	}
	return labels, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// Session is one session's summary, aggregated from its records.
type Session struct {
	Project    string `json:"project"`
	ID         string `json:"id"`
	Service    string `json:"service"`
	Start      int64  `json:"start"` // Unix milliseconds
	End        int64  `json:"end"`
	EventCount int    `json:"event_count"`
	ErrorCount int    `json:"error_count"`
	// HasReplay is a hint from Loki's chunk reference records, set by ListSessions only;
	// Muninn is the authority (Muninn.ListReplays).
	HasReplay bool `json:"has_replay"`
	// User is the session's enduser.id (SDKs), else user.id (Sentry bridge). It names a
	// person: a caller that must not show it clears it.
	User string `json:"user,omitempty"`
}

// SessionList is the answer of ListSessions.
type SessionList struct {
	Sessions []Session `json:"sessions"`
	// Truncated: the read hit ListLimit or the query's Limit, so sessions may be missing
	// or undercounted.
	Truncated bool `json:"truncated"`
}

// Event is one record of a session's timeline.
type Event struct {
	Time     int64  `json:"time"` // Unix milliseconds
	Name     string `json:"name"`
	Severity string `json:"severity,omitempty"`
	ViewID   string `json:"view_id,omitempty"`
	TraceID  string `json:"trace_id,omitempty"`
	SpanID   string `json:"span_id,omitempty"`
	// Attributes are every label of the record except the ones above (and the session,
	// project and service), keyed as Loki writes them ("." as "_"). They include identity
	// attributes (enduser.*, user.*, client.address): see the redact package.
	Attributes map[string]string `json:"attributes,omitempty"`
	Body       string            `json:"body,omitempty"`
}

// SessionEvents is the answer of SessionEvents.
type SessionEvents struct {
	Session Session `json:"session"`
	Events  []Event `json:"events"`
	// Truncated: the session has more events in the range than one read returns
	// (EventLimit); the summary counts only the events read.
	Truncated bool `json:"truncated"`
}

// SessionQuery filters ListSessions.
type SessionQuery struct {
	TimeRange
	Project string // empty: every project
	Limit   int    // sessions returned, default 200
}

// Replay chunk references are telemetry about telemetry; sessions and timelines leave them out.
const replaySelector = `event_name!~"ouo[.]replay[.]chunk"`

// coreKeys are the labels that become fields of Session or Event, not attributes.
var coreKeys = map[string]bool{
	"event_name": true, "severity_text": true, "session_id": true, "ouo_view_id": true,
	"trace_id": true, "span_id": true, "service_name": true, "ouo_project_id": true,
}

func (s *Session) add(l LokiLine) {
	ms := l.Time.UnixMilli()
	if s.Start == 0 || ms < s.Start {
		s.Start = ms
	}
	if ms > s.End {
		s.End = ms
	}
	s.EventCount++
	if isError(l.Labels) {
		s.ErrorCount++
	}
	if s.Service == "" {
		s.Service = l.Labels["service_name"]
	}
	if s.User == "" {
		// enduser.id from the SDKs (setUser); user.id from the Sentry bridge.
		for _, k := range []string{"enduser_id", "user_id"} {
			if u := l.Labels[k]; u != "" {
				s.User = u
				break
			}
		}
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

// ListSessions lists the sessions that have records in the range, newest first. It reads
// at most ListLimit records (newest first) and groups them by session, so with heavy
// traffic the oldest sessions of the range may be missing or undercounted: Truncated says so.
func (l *Loki) ListSessions(ctx context.Context, q SessionQuery) (*SessionList, error) {
	from, to, err := q.window(l.Now)
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
	limit := orDefault(l.ListLimit, 5000)
	lines, err := l.QueryRange(ctx, `{ouo_project_id`+project+`, `+replaySelector+`} | session_id != ""`, from, to, limit, true)
	if err != nil {
		return nil, err
	}
	sessions := map[[2]string]*Session{}
	for _, line := range lines {
		k := [2]string{line.Labels["ouo_project_id"], line.Labels["session_id"]}
		s := sessions[k]
		if s == nil {
			s = &Session{Project: k[0], ID: k[1]}
			sessions[k] = s
		}
		s.add(line)
	}
	// Replay hint: sessions with chunk reference records in the range. A failed hint
	// leaves HasReplay false; the list is still answered.
	hint := `sum by (ouo_project_id, session_id) (count_over_time({ouo_project_id` + project +
		`, event_name="ouo.replay.chunk"} [` + fmt.Sprintf("%ds", int(to.Sub(from).Seconds())) + `]))`
	if series, err := l.QueryVector(ctx, hint, to); err == nil {
		for _, m := range series {
			if s := sessions[[2]string{m["ouo_project_id"], m["session_id"]}]; s != nil {
				s.HasReplay = true
			}
		}
	}
	out := &SessionList{Sessions: make([]Session, 0, len(sessions)), Truncated: len(lines) >= limit}
	for _, s := range sessions {
		out.Sessions = append(out.Sessions, *s)
	}
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].End > out.Sessions[j].End })
	if n := orDefault(q.Limit, 200); len(out.Sessions) > n {
		out.Sessions = out.Sessions[:n]
		out.Truncated = true
	}
	return out, nil
}

// SessionEvents returns one session's summary and its event timeline, oldest first.
// ErrNotFound when Loki has no record of it in the range.
func (l *Loki) SessionEvents(ctx context.Context, project, session string, r TimeRange) (*SessionEvents, error) {
	if err := checkProject(project); err != nil {
		return nil, err
	}
	if err := checkID("session", session); err != nil {
		return nil, err
	}
	from, to, err := r.window(l.Now)
	if err != nil {
		return nil, err
	}
	limit := orDefault(l.EventLimit, 5000)
	logql := `{ouo_project_id="` + project + `", ` + replaySelector + `} | session_id="` + session + `"`
	lines, err := l.QueryRange(ctx, logql, from, to, limit, false)
	if err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		return nil, ErrNotFound
	}
	out := &SessionEvents{Session: Session{Project: project, ID: session}, Events: make([]Event, 0, len(lines)), Truncated: len(lines) >= limit}
	for _, line := range lines {
		out.Session.add(line)
		out.Events = append(out.Events, event(line))
	}
	return out, nil
}

func event(l LokiLine) Event {
	e := Event{
		Time:     l.Time.UnixMilli(),
		Name:     l.Labels["event_name"],
		Severity: l.Labels["severity_text"],
		ViewID:   l.Labels["ouo_view_id"],
		TraceID:  l.Labels["trace_id"],
		SpanID:   l.Labels["span_id"],
		Body:     l.Body,
	}
	if e.Name == "" {
		e.Name = "log"
	}
	for k, v := range l.Labels {
		if coreKeys[k] {
			continue
		}
		if e.Attributes == nil {
			e.Attributes = map[string]string{}
		}
		e.Attributes[k] = v
	}
	return e
}
