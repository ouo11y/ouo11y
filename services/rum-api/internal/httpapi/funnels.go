package httpapi

import (
	"context"
	"encoding/json"
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

// Funnel reports (docs/specs/funnels.md, ADR-0012).

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

// funnelRequest is the body of POST /v1/funnels/query.
type funnelRequest struct {
	Steps   []funnel.Step `json:"steps"`
	From    string        `json:"from"`
	To      string        `json:"to"`
	Within  string        `json:"within"` // Go duration plus d/w, e.g. "30m", "1d"; empty: no bound
	Filters FunnelFilters `json:"filters"`
}

type funnelQuery struct {
	def      funnel.Definition
	from, to time.Time
	filters  FunnelFilters
}

type funnelResponse struct {
	Steps    []funnel.StepResult `json:"steps"`
	Sessions int                 `json:"sessions"` // sessions that entered step 1
	Users    int                 `json:"users"`
	Within   *int64              `json:"within_ms"`
	From     time.Time           `json:"from"`
	To       time.Time           `json:"to"`
}

type droppedSession struct {
	SessionID  string    `json:"session_id"`
	UserID     string    `json:"user_id,omitempty"`
	EnteredAt  time.Time `json:"entered_at"`   // step 1
	LastStepAt time.Time `json:"last_step_at"` // the last step reached (step N-1)
	LastPath   string    `json:"last_path,omitempty"`
	HasReplay  bool      `json:"has_replay"`
	ReplayKind *string   `json:"replay_kind"`
}

type droppedResponse struct {
	Step       int              `json:"step"`
	Sessions   []droppedSession `json:"sessions"`
	Total      int              `json:"total"`
	Offset     int              `json:"offset"`
	Limit      int              `json:"limit"`
	NextOffset *int             `json:"next_offset"`
	From       time.Time        `json:"from"`
	To         time.Time        `json:"to"`
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

func (s *Server) resolveFunnel(steps []funnel.Step, from, to, within string, f FunnelFilters) (funnelQuery, error) {
	fq := funnelQuery{def: funnel.Definition{Steps: steps}, filters: f}
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
// events narrowed to the step paths, and the step event names.
func funnelQueries(def funnel.Definition, f FunnelFilters) []string {
	var paths, names []string
	seen := map[string]bool{}
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
			names = append(names, regexp.QuoteMeta(st.Value))
		}
	}
	var out []string
	if len(paths) > 0 {
		out = append(out, f.selector(`="navigation"`)+` | url_path=~`+strconv.Quote(strings.Join(paths, "|")))
	}
	if len(names) > 0 {
		out = append(out, f.selector(`=~`+strconv.Quote(strings.Join(names, "|"))))
	}
	return out
}

type funnelCacheEntry struct {
	paths   []funnel.Path
	expires time.Time
}

type funnelCache struct {
	mu      sync.Mutex
	entries map[string]funnelCacheEntry
}

func (fq funnelQuery) key() string {
	b, _ := json.Marshal([]any{fq.def.Steps, fq.def.Within, fq.filters, fq.from.UnixNano(), fq.to.UnixNano()})
	return string(b)
}

// paths runs the step queries concurrently, joins the events per session and
// walks them. Results are cached for FunnelCacheTTL so the report and its
// drop-off lists share one Loki read.
func (s *Server) funnelPaths(ctx context.Context, fq funnelQuery) ([]funnel.Path, error) {
	key := fq.key()
	ttl := s.opts.FunnelCacheTTL
	if ttl > 0 {
		s.funnels.mu.Lock()
		e, ok := s.funnels.entries[key]
		s.funnels.mu.Unlock()
		if ok && time.Now().Before(e.expires) {
			return e.paths, nil
		}
	}
	queries := funnelQueries(fq.def, fq.filters)
	results := make([][]session.Event, len(queries))
	errs := make([]error, len(queries))
	var wg sync.WaitGroup
	for i, q := range queries {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = s.events.EventsQuery(ctx, q, fq.from, fq.to)
		}()
	}
	wg.Wait()
	var all []session.Event
	for i := range queries {
		if errs[i] != nil {
			return nil, errs[i]
		}
		all = append(all, results[i]...)
	}
	paths := funnel.Paths(fq.def, all)
	if ttl > 0 {
		s.funnels.mu.Lock()
		now := time.Now()
		for k, e := range s.funnels.entries {
			if now.After(e.expires) {
				delete(s.funnels.entries, k)
			}
		}
		s.funnels.entries[key] = funnelCacheEntry{paths: paths, expires: now.Add(ttl)}
		s.funnels.mu.Unlock()
	}
	return paths, nil
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
	fq, err := s.resolveFunnel(req.Steps, req.From, req.To, req.Within, req.Filters)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	paths, err := s.funnelPaths(r.Context(), fq)
	if err != nil {
		s.lokiError(w, err)
		return
	}
	rows := funnel.Report(fq.def, paths)
	resp := funnelResponse{Steps: rows, Sessions: rows[0].Sessions, Users: rows[0].Users, From: fq.from, To: fq.to}
	if fq.def.Within > 0 {
		ms := fq.def.Within.Milliseconds()
		resp.Within = &ms
	}
	writeJSON(w, http.StatusOK, resp)
}

// parseFunnelURL reads a funnel from query parameters: steps=page:/,event:x
// (comma separated, or repeated), from, to, within and the filters.
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
	return s.resolveFunnel(steps, q.Get("from"), q.Get("to"), q.Get("within"), FunnelFilters{
		Service: q.Get("service"), Environment: q.Get("environment"), Release: q.Get("release"),
		Platform: q.Get("platform"), Project: q.Get("project"),
	})
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
// that reached step N-1 but not step N, latest first, paginated by offset.
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
	paths, err := s.funnelPaths(r.Context(), fq)
	if err != nil {
		s.lokiError(w, err)
		return
	}
	dropped := funnel.Dropped(paths, step)
	resp := droppedResponse{Step: step, Sessions: []droppedSession{}, Total: len(dropped), Offset: offset, Limit: limit, From: fq.from, To: fq.to}
	end := min(offset+limit, len(dropped))
	for _, p := range dropped[min(offset, len(dropped)):end] {
		ds := droppedSession{SessionID: p.SessionID, UserID: p.UserID, EnteredAt: p.At[0], LastStepAt: p.At[len(p.At)-1], LastPath: p.LastPath}
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
