package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/funnel"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/timerange"
)

// Funnel reports (docs/specs/funnels.md, ADR-0012, ADR-0019).

const (
	defaultFunnelRange = 24 * time.Hour
	// funnelTimeGrain rounds from/to down so relative ranges ("now-24h")
	// share a cache entry for a few seconds.
	funnelTimeGrain   = 10 * time.Second
	defaultDropLimit  = 50
	maxDropLimit      = 500
	maxSuggestions    = 200
	maxFunnelBodySize = 64 << 10
)

// CappedSource is the optional Loki capability that reports whether a read
// was cut at the client's event cap (loki.Client implements it). Without it
// a funnel is never marked truncated.
type CappedSource interface {
	EventsQueryCapped(ctx context.Context, query string, start, end time.Time) ([]session.Event, bool, error)
}

// CountSource is the optional Loki capability the step suggestions use
// (loki.Client implements it).
type CountSource interface {
	Counts(ctx context.Context, query, by string, start, end time.Time) (map[string]int, error)
}

// FunnelFilters scope a funnel to one slice of the telemetry. Service,
// environment, platform and project are Loki stream labels; release
// (service.version) is structured metadata.
type FunnelFilters struct {
	Service     string `json:"service,omitempty"`
	Environment string `json:"environment,omitempty"`
	Release     string `json:"release,omitempty"`
	Platform    string `json:"platform,omitempty"`
	Project     string `json:"project,omitempty"`
}

// failureSpec is the failure event of a request: an event name with optional
// conditions, or off. Absent: funnel.DefaultFailure (any exception).
type failureSpec struct {
	Event string             `json:"event,omitempty"`
	Where []funnel.Condition `json:"where,omitempty"`
	Off   bool               `json:"off,omitempty"`
}

// failureOff is the compact form that turns failure tracking off.
const failureOff = "off"

// funnelRequest is the body of POST /v1/funnels/query.
type funnelRequest struct {
	Steps   []funnel.Step `json:"steps"`
	From    string        `json:"from"`
	To      string        `json:"to"`
	Within  string        `json:"within"` // Go duration plus d/w, e.g. "30m", "1d"; empty: no bound
	Filters FunnelFilters `json:"filters"`
	Failure *failureSpec  `json:"failure,omitempty"`
}

type funnelQuery struct {
	def      funnel.Definition
	from, to time.Time
	filters  FunnelFilters
}

// funnelRead is one Loki query of a funnel; kind names it in truncated.
type funnelRead struct {
	kind  string // pages, events, failures
	query string
}

// funnelResult is what one evaluation of a funnel query yields (cached).
type funnelResult struct {
	paths []funnel.Path
	// truncated lists the reads cut at the event cap; completeUntil is the
	// earliest last event of those reads: the funnel saw every event up to
	// there.
	truncated     []string
	completeUntil *time.Time
}

// truncation is the part of a response that reports a read cut at the cap.
type truncation struct {
	Truncated       bool       `json:"truncated"`
	TruncatedReads  []string   `json:"truncated_reads"`
	EventsReadLimit int        `json:"events_read_limit"`
	CompleteUntil   *time.Time `json:"complete_until"`
}

type funnelResponse struct {
	Steps    []funnel.StepResult `json:"steps"`
	Sessions int                 `json:"sessions"` // sessions that entered step 1
	Users    int                 `json:"users"`
	// Failed is the sessions that stopped after a failure event, over all
	// steps; Failure is the failure event used (null: off).
	Failed  int          `json:"failed"`
	Failure *funnel.Step `json:"failure"`
	Within  *int64       `json:"within_ms"`
	From    time.Time    `json:"from"`
	To      time.Time    `json:"to"`
	truncation
}

type droppedSession struct {
	SessionID  string    `json:"session_id"`
	UserID     string    `json:"user_id,omitempty"`
	EnteredAt  time.Time `json:"entered_at"`   // step 1
	LastStepAt time.Time `json:"last_step_at"` // the last step reached (step N-1)
	LastPath   string    `json:"last_path,omitempty"`
	// Outcome is failed or abandoned; the failure fields describe the first
	// failure event after the last step reached.
	Outcome        funnel.Outcome `json:"outcome"`
	FailedAt       *time.Time     `json:"failed_at,omitempty"`
	FailureEvent   string         `json:"failure_event,omitempty"`
	FailureMessage string         `json:"failure_message,omitempty"`
	HasReplay      bool           `json:"has_replay"`
	ReplayKind     *string        `json:"replay_kind"`
}

type droppedResponse struct {
	Step       int              `json:"step"`
	Outcome    funnel.Outcome   `json:"outcome"`
	Sessions   []droppedSession `json:"sessions"`
	Total      int              `json:"total"`
	Offset     int              `json:"offset"`
	Limit      int              `json:"limit"`
	NextOffset *int             `json:"next_offset"`
	From       time.Time        `json:"from"`
	To         time.Time        `json:"to"`
	truncation
}

type suggestion struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

type suggestionsResponse struct {
	Pages  []suggestion `json:"pages"`
	Events []suggestion `json:"events"`
	From   time.Time    `json:"from"`
	To     time.Time    `json:"to"`
}

// failureStep is the failure event of a spec: nil when off, the default when
// the spec is absent or names no event.
func (fs *failureSpec) step() *funnel.Step {
	switch {
	case fs == nil:
		d := funnel.DefaultFailure
		return &d
	case fs.Off:
		return nil
	case fs.Event == "":
		d := funnel.DefaultFailure
		d.Where = fs.Where
		return &d
	}
	return &funnel.Step{Kind: funnel.KindEvent, Value: fs.Event, Where: fs.Where}
}

// parseFailure reads the compact failure parameter: event:<name>[ where …]
// or off; empty is the default.
func parseFailure(v string) (*failureSpec, error) {
	switch v {
	case "":
		return nil, nil
	case failureOff:
		return &failureSpec{Off: true}, nil
	}
	st, err := funnel.ParseStep(v)
	if err != nil {
		return nil, fmt.Errorf("failure: %w", err)
	}
	if st.Kind != funnel.KindEvent {
		return nil, errors.New("failure: want event:<name> or off")
	}
	return &failureSpec{Event: st.Value, Where: st.Where}, nil
}

func (s *Server) resolveFunnel(steps []funnel.Step, from, to, within string, f FunnelFilters, failure *failureSpec) (funnelQuery, error) {
	fq := funnelQuery{def: funnel.Definition{Steps: steps, Failure: failure.step()}, filters: f}
	if within != "" {
		d, err := timerange.ParseDuration(within)
		if err != nil {
			return fq, badRequest{fmt.Errorf("within: %w", err)}
		}
		fq.def.Within = d
	}
	if err := fq.def.Validate(); err != nil {
		return fq, badRequest{err}
	}
	if f.Project != "" && !ValidProjectID(f.Project) {
		return fq, errorf("invalid project id")
	}
	var err error
	fq.from, fq.to, err = timerange.Range(from, to, s.opts.Now(), defaultFunnelRange)
	if err != nil {
		return fq, badRequest{err}
	}
	fq.from, fq.to = fq.from.Truncate(funnelTimeGrain), fq.to.Truncate(funnelTimeGrain)
	if fq.to.Sub(fq.from) > funnel.MaxRange {
		return fq, badRequest{fmt.Errorf("range is at most %s", funnel.MaxRange)}
	}
	return fq, nil
}

// selector is the stream selector for event names (a regex alternative).
func (f FunnelFilters) selector(eventNames string) string {
	sel := []string{`service_name=~".+"`}
	if f.Service != "" {
		sel[0] = `service_name=` + strconv.Quote(f.Service)
	}
	sel = append(sel, "event_name"+eventNames)
	for label, v := range map[string]string{"deployment_environment_name": f.Environment, "ouo_platform": f.Platform, "ouo_project_id": f.Project} {
		if v != "" {
			sel = append(sel, label+"="+strconv.Quote(v))
		}
	}
	sort.Strings(sel[1:])
	q := "{" + strings.Join(sel, ", ") + "}"
	if f.Release != "" {
		q += ` | service_version=` + strconv.Quote(f.Release)
	}
	return q
}

// funnelQueries returns one LogQL query per step kind present: navigation
// events narrowed to the step paths, the step event names (with their
// conditions as label filters, ADR-0019), and the failure event.
func funnelQueries(def funnel.Definition, f FunnelFilters) []funnelRead {
	var paths, names []string
	seen := map[string]bool{}
	// Per event name: the condition sets of its steps; a step without
	// conditions makes the name unconditional.
	conds := map[string][][]funnel.Condition{}
	plain := map[string]bool{}
	for _, st := range def.Steps {
		if seen[st.String()] {
			continue
		}
		seen[st.String()] = true
		switch st.Kind {
		case funnel.KindPage:
			p := regexp.QuoteMeta(st.Value)
			if st.Match == funnel.MatchPrefix {
				p += ".*"
			}
			paths = append(paths, p)
		case funnel.KindEvent:
			if !plain[st.Value] && conds[st.Value] == nil {
				names = append(names, st.Value)
			}
			if len(st.Where) == 0 {
				plain[st.Value] = true
			} else {
				conds[st.Value] = append(conds[st.Value], st.Where)
			}
		}
	}
	var out []funnelRead
	if len(paths) > 0 {
		out = append(out, funnelRead{"pages", f.selector(`="navigation"`) + ` | url_path=~` + strconv.Quote(strings.Join(paths, "|"))})
	}
	if len(names) > 0 {
		quoted := make([]string, len(names))
		for i, n := range names {
			quoted[i] = regexp.QuoteMeta(n)
		}
		q := f.selector(`=~` + strconv.Quote(strings.Join(quoted, "|")))
		if filter := eventsFilter(names, plain, conds); filter != "" {
			q += " | " + filter
		}
		out = append(out, funnelRead{"events", q})
	}
	if fs := def.Failure; fs != nil {
		q := f.selector(`=` + strconv.Quote(fs.Value))
		if len(fs.Where) > 0 {
			q += " | " + funnel.ConditionsLogQL(fs.Where)
		}
		out = append(out, funnelRead{"failures", q})
	}
	return out
}

// eventsFilter is the label filter expression of the events query: empty
// when no event step has conditions, else one alternative per event name,
// either the bare name or the name and its steps' condition sets:
//
//	(event_name="a") or (event_name="b" and ((k="v" and k2!="w") or (k="x")))
//
// With a single conditional name and nothing else, the name test is left
// out (the selector already narrows to it). Every operand is parenthesised,
// so LogQL's and/or precedence does not matter.
func eventsFilter(names []string, plain map[string]bool, conds map[string][][]funnel.Condition) string {
	conditional := 0
	for _, n := range names {
		if !plain[n] {
			conditional++
		}
	}
	if conditional == 0 {
		return ""
	}
	sets := func(n string) string {
		alts := make([]string, 0, len(conds[n]))
		for _, cs := range conds[n] {
			alts = append(alts, "("+funnel.ConditionsLogQL(cs)+")")
		}
		return strings.Join(alts, " or ")
	}
	if len(names) == 1 {
		return sets(names[0])
	}
	alts := make([]string, 0, len(names))
	for _, n := range names {
		test := "event_name=" + strconv.Quote(n)
		if plain[n] {
			alts = append(alts, "("+test+")")
		} else {
			alts = append(alts, "("+test+" and ("+sets(n)+"))")
		}
	}
	return strings.Join(alts, " or ")
}

type funnelCacheEntry struct {
	result  funnelResult
	expires time.Time
}

type funnelCache struct {
	mu      sync.Mutex
	entries map[string]funnelCacheEntry
}

func (fq funnelQuery) key() string {
	b, _ := json.Marshal([]any{fq.def.Steps, fq.def.Within, fq.def.Failure, fq.filters, fq.from.UnixNano(), fq.to.UnixNano()})
	return string(b)
}

// funnelPaths runs the step queries concurrently, joins the events per
// session and walks them. Results are cached for FunnelCacheTTL so the report
// and its drop-off lists share one Loki read.
func (s *Server) funnelPaths(ctx context.Context, fq funnelQuery) (funnelResult, error) {
	key := fq.key()
	ttl := s.opts.FunnelCacheTTL
	if ttl > 0 {
		s.funnels.mu.Lock()
		e, ok := s.funnels.entries[key]
		s.funnels.mu.Unlock()
		if ok && time.Now().Before(e.expires) {
			return e.result, nil
		}
	}
	reads := funnelQueries(fq.def, fq.filters)
	results := make([][]session.Event, len(reads))
	capped := make([]bool, len(reads))
	errs := make([]error, len(reads))
	var wg sync.WaitGroup
	for i, rd := range reads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if c, ok := s.events.(CappedSource); ok {
				results[i], capped[i], errs[i] = c.EventsQueryCapped(ctx, rd.query, fq.from, fq.to)
				return
			}
			results[i], errs[i] = s.events.EventsQuery(ctx, rd.query, fq.from, fq.to)
		}()
	}
	wg.Wait()
	var res funnelResult
	var all []session.Event
	seen := map[string]bool{}
	for i, rd := range reads {
		if errs[i] != nil {
			return funnelResult{}, errs[i]
		}
		// The failure read can return events the events read also has
		// (failure event = a step event).
		for _, ev := range results[i] {
			if k := ev.Key(); !seen[k] {
				seen[k] = true
				all = append(all, ev)
			}
		}
		if capped[i] {
			res.truncated = append(res.truncated, rd.kind)
			if n := len(results[i]); n > 0 {
				last := results[i][n-1].TS
				if res.completeUntil == nil || last.Before(*res.completeUntil) {
					res.completeUntil = &last
				}
			}
		}
	}
	if res.truncated != nil {
		slog.Warn("funnel read cut at the event cap", "reads", res.truncated, "from", fq.from, "to", fq.to)
	}
	res.paths = funnel.Paths(fq.def, all)
	if ttl > 0 {
		s.funnels.mu.Lock()
		now := time.Now()
		for k, e := range s.funnels.entries {
			if now.After(e.expires) {
				delete(s.funnels.entries, k)
			}
		}
		s.funnels.entries[key] = funnelCacheEntry{result: res, expires: now.Add(ttl)}
		s.funnels.mu.Unlock()
	}
	return res, nil
}

// truncation reports the reads cut at the cap, if any.
func (s *Server) truncation(res funnelResult) truncation {
	t := truncation{Truncated: len(res.truncated) > 0, TruncatedReads: res.truncated, EventsReadLimit: s.eventsReadLimit(), CompleteUntil: res.completeUntil}
	if t.TruncatedReads == nil {
		t.TruncatedReads = []string{}
	}
	return t
}

// eventsReadLimit is the per-read event cap of the Loki client, 0 when the
// event source has none.
func (s *Server) eventsReadLimit() int {
	if l, ok := s.events.(interface{ ReadLimit() int }); ok {
		return l.ReadLimit()
	}
	return 0
}

// postFunnelQuery: POST /v1/funnels/query.
func (s *Server) postFunnelQuery(w http.ResponseWriter, r *http.Request) {
	var req funnelRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxFunnelBodySize))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	fq, err := s.resolveFunnel(req.Steps, req.From, req.To, req.Within, req.Filters, req.Failure)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := s.funnelPaths(r.Context(), fq)
	if err != nil {
		s.lokiError(w, err)
		return
	}
	rows := funnel.Report(fq.def, res.paths)
	resp := funnelResponse{Steps: rows, Sessions: rows[0].Sessions, Users: rows[0].Users, Failure: fq.def.Failure,
		From: fq.from, To: fq.to, truncation: s.truncation(res)}
	for _, row := range rows {
		resp.Failed += row.Failed
	}
	if fq.def.Within > 0 {
		ms := fq.def.Within.Milliseconds()
		resp.Within = &ms
	}
	writeJSON(w, http.StatusOK, resp)
}

// parseFunnelURL reads a funnel from query parameters: steps=page:/,event:x
// (comma separated, or repeated), from, to, within, failure and the filters.
func (s *Server) parseFunnelURL(q url.Values) (funnelQuery, error) {
	var steps []funnel.Step
	for _, v := range q["steps"] {
		for _, part := range splitSteps(v) {
			st, err := funnel.ParseStep(part)
			if err != nil {
				return funnelQuery{}, badRequest{err}
			}
			steps = append(steps, st)
		}
	}
	failure, err := parseFailure(q.Get("failure"))
	if err != nil {
		return funnelQuery{}, badRequest{err}
	}
	return s.resolveFunnel(steps, q.Get("from"), q.Get("to"), q.Get("within"), FunnelFilters{
		Service: q.Get("service"), Environment: q.Get("environment"), Release: q.Get("release"),
		Platform: q.Get("platform"), Project: q.Get("project"),
	}, failure)
}

// splitSteps splits on commas that start a new step ("page:" or "event:"),
// so a comma inside a value is kept.
func splitSteps(v string) []string {
	var out []string
	cur := ""
	for _, part := range strings.Split(v, ",") {
		if cur != "" && !strings.HasPrefix(part, "page:") && !strings.HasPrefix(part, "event:") {
			cur += "," + part
			continue
		}
		if cur != "" {
			out = append(out, cur)
		}
		cur = part
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

// getFunnelDropped: GET /v1/funnels/dropped?step=N&steps=...: the sessions
// that reached step N-1 but not step N, latest first, paginated by offset;
// outcome=failed|abandoned narrows them.
func (s *Server) getFunnelDropped(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	fq, err := s.parseFunnelURL(q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	step, err := strconv.Atoi(q.Get("step"))
	if err != nil || step < 2 || step > len(fq.def.Steps) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("step must be between 2 and %d", len(fq.def.Steps)))
		return
	}
	outcome, err := funnel.ParseOutcome(q.Get("outcome"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, offset := defaultDropLimit, 0
	if v := q.Get("limit"); v != "" {
		if limit, err = strconv.Atoi(v); err != nil || limit <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(limit, maxDropLimit)
	}
	if v := q.Get("offset"); v != "" {
		if offset, err = strconv.Atoi(v); err != nil || offset < 0 {
			writeError(w, http.StatusBadRequest, "offset must be a non-negative integer")
			return
		}
	}
	res, err := s.funnelPaths(r.Context(), fq)
	if err != nil {
		s.lokiError(w, err)
		return
	}
	dropped := funnel.Dropped(res.paths, step, outcome)
	resp := droppedResponse{Step: step, Outcome: outcome, Sessions: []droppedSession{}, Total: len(dropped), Offset: offset, Limit: limit,
		From: fq.from, To: fq.to, truncation: s.truncation(res)}
	end := min(offset+limit, len(dropped))
	for _, p := range dropped[min(offset, len(dropped)):end] {
		ds := droppedSession{SessionID: p.SessionID, UserID: p.UserID, EnteredAt: p.At[0], LastStepAt: p.At[len(p.At)-1], LastPath: p.LastPath,
			Outcome: funnel.OutcomeAbandoned}
		if p.Failed {
			at := p.FailedAt
			ds.Outcome, ds.FailedAt, ds.FailureEvent, ds.FailureMessage = funnel.OutcomeFailed, &at, p.FailureEvent, p.FailureMessage
		}
		if s.store.Has(r.Context(), p.SessionID) {
			if m, err := s.store.Meta(r.Context(), p.SessionID); err == nil {
				kind := m.Kind
				ds.HasReplay, ds.ReplayKind = true, &kind
			}
		}
		resp.Sessions = append(resp.Sessions, ds)
	}
	if end < len(dropped) {
		resp.NextOffset = &end
	}
	writeJSON(w, http.StatusOK, resp)
}

// getFunnelSteps: GET /v1/funnels/steps: known page paths and custom event
// names in the range with their counts, most frequent first, for the step
// builder's autocomplete. Optional `q` keeps values containing it.
func (s *Server) getFunnelSteps(w http.ResponseWriter, r *http.Request) {
	counter, ok := s.events.(CountSource)
	if !ok {
		writeError(w, http.StatusNotImplemented, "step suggestions need a Loki client")
		return
	}
	q := r.URL.Query()
	f := FunnelFilters{Service: q.Get("service"), Environment: q.Get("environment"), Release: q.Get("release"), Platform: q.Get("platform"), Project: q.Get("project")}
	if f.Project != "" && !ValidProjectID(f.Project) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	from, to, err := timerange.Range(q.Get("from"), q.Get("to"), s.opts.Now(), defaultFunnelRange)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	from, to = from.Truncate(funnelTimeGrain), to.Truncate(funnelTimeGrain)
	if to.Sub(from) > funnel.MaxRange {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("range is at most %s", funnel.MaxRange))
		return
	}
	var pages, events map[string]int
	var perr, eerr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pages, perr = counter.Counts(r.Context(), f.selector(`="navigation"`), funnel.PathAttr, from, to)
	}()
	go func() {
		defer wg.Done()
		events, eerr = counter.Counts(r.Context(), f.selector(`=~".+"`)+` | ouo_event_custom="true"`, "event_name", from, to)
	}()
	wg.Wait()
	for _, err := range []error{perr, eerr} {
		if err != nil {
			slog.Error("funnel steps: loki", "error", err)
			writeError(w, http.StatusBadGateway, "loki: "+err.Error())
			return
		}
	}
	contains := q.Get("q")
	writeJSON(w, http.StatusOK, suggestionsResponse{Pages: rank(pages, contains), Events: rank(events, contains), From: from, To: to})
}

func rank(m map[string]int, contains string) []suggestion {
	out := []suggestion{}
	for v, n := range m {
		if contains == "" || strings.Contains(v, contains) {
			out = append(out, suggestion{Value: v, Count: n})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Value < out[j].Value
	})
	if len(out) > maxSuggestions {
		out = out[:maxSuggestions]
	}
	return out
}
