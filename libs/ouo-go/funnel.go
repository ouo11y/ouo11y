package ouogo

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Funnels (docs/specs/funnels.md): how many sessions reach each of an ordered list of
// steps, where a step is a page path or a custom event name. Ported from rum-api's
// internal/funnel and its /v1/funnels handlers.

// Funnel limits.
const (
	FunnelMinSteps    = 2
	FunnelMaxSteps    = 10
	FunnelMaxValueLen = 256
	FunnelMaxWithin   = 7 * 24 * time.Hour
)

// StepKind is what a funnel step matches.
type StepKind string

const (
	StepPage  StepKind = "page"  // the path of a navigation event
	StepEvent StepKind = "event" // the event name of any other event
)

// StepMatch is how a page step compares the path.
type StepMatch string

const (
	MatchExact  StepMatch = "exact"
	MatchPrefix StepMatch = "prefix"
)

// Navigation event names. "navigation" with url.path is the mobile SDKs' (and the MVP web
// SDK's) page or screen change; "browser.navigation" with url.full is the web SDK's since
// 0.4.0 (client SDK spec). A page step matches both.
const (
	navigationEvent        = "navigation"
	browserNavigationEvent = "browser.navigation"
)

func isNavigation(name string) bool {
	return name == navigationEvent || name == browserNavigationEvent
}

// navPath is the path of a navigation record: url.path, else the path of url.full.
func navPath(labels map[string]string) (string, bool) {
	if !isNavigation(labels["event_name"]) {
		return "", false
	}
	if p := labels["url_path"]; p != "" {
		return p, true
	}
	if full := labels["url_full"]; full != "" {
		if u, err := url.Parse(full); err == nil {
			p := u.Path
			if p == "" {
				p = "/"
			}
			return p, true
		}
	}
	return "", false
}

// userOf is the record's user: enduser.id (SDKs since the client SDK spec), else user.id
// (mobile SDKs, Sentry bridge). It names a person.
func userOf(labels map[string]string) string {
	if u := labels["enduser_id"]; u != "" {
		return u
	}
	return labels["user_id"]
}

// FunnelStep is one step.
type FunnelStep struct {
	Kind  StepKind  `json:"kind"`
	Match StepMatch `json:"match,omitempty"` // page steps; default exact
	Value string    `json:"value"`           // path or event name
}

func (s FunnelStep) matches(l LokiLine) bool {
	switch s.Kind {
	case StepPage:
		p, ok := navPath(l.Labels)
		if !ok {
			return false
		}
		if s.Match == MatchPrefix {
			return strings.HasPrefix(p, s.Value)
		}
		return p == s.Value
	case StepEvent:
		name := l.Labels["event_name"]
		return name == s.Value && !isNavigation(name)
	}
	return false
}

// String is the compact form used in URLs: page:/cart, page:/products/* (prefix),
// event:add_to_cart.
func (s FunnelStep) String() string {
	v := s.Value
	if s.Kind == StepPage && s.Match == MatchPrefix {
		v += "*"
	}
	return string(s.Kind) + ":" + v
}

// ParseFunnelStep reads the compact form of String.
func ParseFunnelStep(v string) (FunnelStep, error) {
	kind, val, ok := strings.Cut(v, ":")
	if !ok {
		return FunnelStep{}, &BadRequestError{Msg: fmt.Sprintf("step %q: want page:<path> or event:<name>", v)}
	}
	s := FunnelStep{Kind: StepKind(kind), Value: val}
	if s.Kind == StepPage {
		s.Match = MatchExact
		if strings.HasSuffix(val, "*") {
			s.Match, s.Value = MatchPrefix, strings.TrimSuffix(val, "*")
		}
	}
	return s, s.validate()
}

// ParseFunnelSteps splits a comma separated list on commas that start a new step ("page:"
// or "event:"), so a comma inside a value is kept, and parses each step.
func ParseFunnelSteps(v string) ([]FunnelStep, error) {
	var parts []string
	cur := ""
	for _, part := range strings.Split(v, ",") {
		if cur != "" && !strings.HasPrefix(part, "page:") && !strings.HasPrefix(part, "event:") {
			cur += "," + part
			continue
		}
		if cur != "" {
			parts = append(parts, cur)
		}
		cur = part
	}
	if cur != "" {
		parts = append(parts, cur)
	}
	steps := make([]FunnelStep, 0, len(parts))
	for _, p := range parts {
		s, err := ParseFunnelStep(p)
		if err != nil {
			return nil, err
		}
		steps = append(steps, s)
	}
	return steps, nil
}

// A step value is printable and holds no quote, backslash or backtick, so it cannot end
// a LogQL string even before it is quoted.
var reStepValue = regexp.MustCompile("^[^\\x00-\\x1f\\x7f\"\\\\`]+$")

func (s *FunnelStep) validate() error {
	bad := func(f string, a ...any) error { return &BadRequestError{Msg: fmt.Sprintf(f, a...)} }
	if s.Value == "" || len(s.Value) > FunnelMaxValueLen {
		return bad("step value must be 1 to %d characters", FunnelMaxValueLen)
	}
	if !reStepValue.MatchString(s.Value) {
		return bad("step %q: no control characters, quotes, backslashes or backticks", s.Value)
	}
	switch s.Kind {
	case StepPage:
		if s.Match == "" {
			s.Match = MatchExact
		}
		if s.Match != MatchExact && s.Match != MatchPrefix {
			return bad("step %q: match must be exact or prefix", s.Value)
		}
		if !strings.HasPrefix(s.Value, "/") {
			return bad("page step %q must start with /", s.Value)
		}
	case StepEvent:
		if s.Match != "" && s.Match != MatchExact {
			return bad("event step %q: only exact match", s.Value)
		}
		s.Match = ""
		if isNavigation(s.Value) {
			return bad("event step cannot be %s: use a page step", s.Value)
		}
	default:
		return bad("step kind must be page or event, got %q", s.Kind)
	}
	return nil
}

// Filters scope a funnel or the health stats to one slice of the telemetry. Each is
// optional. Project, service, environment and platform are Loki stream labels; release
// (service.version) is structured metadata.
type Filters struct {
	Project     string `json:"project,omitempty"`
	Service     string `json:"service,omitempty"`
	Environment string `json:"environment,omitempty"`
	Release     string `json:"release,omitempty"`
	Platform    string `json:"platform,omitempty"`
}

// A filter value is a service name, version, environment or platform: no quotes,
// backslashes, braces or spaces.
var reFilter = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`)

func (f Filters) check() error {
	if f.Project != "" {
		if err := checkProject(f.Project); err != nil {
			return err
		}
	}
	for name, v := range map[string]string{"service": f.Service, "environment": f.Environment, "release": f.Release, "platform": f.Platform} {
		if v != "" && !reFilter.MatchString(v) {
			return &BadRequestError{Msg: name + " must match " + reFilter.String()}
		}
	}
	return nil
}

// selector is the stream selector for an event_name matcher, any extra matchers, plus the
// release filter. The values were checked by check.
func (f Filters) selector(eventName string, extra ...string) string {
	sel := []string{`service_name=~".+"`}
	if f.Service != "" {
		sel[0] = `service_name=` + strconv.Quote(f.Service)
	}
	sel = append(sel, "event_name"+eventName)
	sel = append(sel, extra...)
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

// FunnelQuery is one funnel over a time range.
type FunnelQuery struct {
	TimeRange
	Steps []FunnelStep
	// Within bounds the time from step 1 to the last reached step; 0 is unbounded (the
	// range still bounds it). At most FunnelMaxWithin.
	Within  time.Duration
	Filters Filters
}

func (q *FunnelQuery) check() error {
	if len(q.Steps) < FunnelMinSteps || len(q.Steps) > FunnelMaxSteps {
		return &BadRequestError{Msg: fmt.Sprintf("a funnel has %d to %d steps", FunnelMinSteps, FunnelMaxSteps)}
	}
	for i := range q.Steps {
		if err := q.Steps[i].validate(); err != nil {
			return err
		}
	}
	if q.Within < 0 || q.Within > FunnelMaxWithin {
		return &BadRequestError{Msg: fmt.Sprintf("within must be between 0 and %s", FunnelMaxWithin)}
	}
	return q.Filters.check()
}

// FunnelStepResult is one row of a funnel report.
type FunnelStepResult struct {
	Step     FunnelStep `json:"step"`
	Label    string     `json:"label"`
	Sessions int        `json:"sessions"`
	Users    int        `json:"users"`
	// ConversionFromFirst and ConversionFromPrevious are percentages (0..100, 2 decimals).
	ConversionFromFirst    float64 `json:"conversion_from_first"`
	ConversionFromPrevious float64 `json:"conversion_from_previous"`
	// DroppedOff is the sessions that reached the previous step but not this one (0 for
	// step 1).
	DroppedOff int `json:"dropped_off"`
	// MedianMs and P75Ms are the time from the previous step over the sessions that
	// reached this step (nearest rank); nil for step 1 and when no session reached it.
	MedianMs *int64 `json:"median_ms"`
	P75Ms    *int64 `json:"p75_ms"`
}

// FunnelReport is the answer of Loki.Funnel.
type FunnelReport struct {
	Steps    []FunnelStepResult `json:"steps"`
	Sessions int                `json:"sessions"` // sessions that entered step 1
	Users    int                `json:"users"`
	WithinMs *int64             `json:"within_ms"`
	From     time.Time          `json:"from"`
	To       time.Time          `json:"to"`
	// Truncated: a step query hit FunnelEventLimit, so sessions may be missing.
	Truncated bool `json:"truncated"`
}

// DroppedSession is one session of FunnelDropped. Whether it has a replay is Muninn's
// answer (Muninn.ListReplays), not Loki's.
type DroppedSession struct {
	SessionID  string    `json:"session_id"`
	User       string    `json:"user_id,omitempty"` // names a person
	EnteredAt  time.Time `json:"entered_at"`        // step 1
	LastStepAt time.Time `json:"last_step_at"`      // the last step reached
	LastPath   string    `json:"last_path,omitempty"`
}

// FunnelDropped is the answer of Loki.FunnelDropped.
type FunnelDropped struct {
	Step       int              `json:"step"`
	Sessions   []DroppedSession `json:"sessions"`
	Total      int              `json:"total"`
	Offset     int              `json:"offset"`
	Limit      int              `json:"limit"`
	NextOffset *int             `json:"next_offset"`
	From       time.Time        `json:"from"`
	To         time.Time        `json:"to"`
	Truncated  bool             `json:"truncated"`
}

// StepSuggestion is a value seen in the range and how many records carry it.
type StepSuggestion struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// StepSuggestions is the answer of Loki.FunnelSteps.
type StepSuggestions struct {
	Pages  []StepSuggestion `json:"pages"`
	Events []StepSuggestion `json:"events"`
	From   time.Time        `json:"from"`
	To     time.Time        `json:"to"`
}

// funnelPath is how far one session got.
type funnelPath struct {
	session, user string
	reached       int         // steps reached, 1..len(steps)
	at            []time.Time // at[i]: when step i was reached
	lastPath      string      // the session's last page path in the range
}

// walk computes the path of one session from its records in time order. Steps must be
// hit in order; other records in between are ignored, and a repeated step does not move
// the session forward. Every occurrence of step 1 is tried as a start and the deepest
// path wins (the earliest start on ties), so a session that retries later inside the
// window is credited.
func walk(q *FunnelQuery, lines []LokiLine) (funnelPath, bool) {
	var best funnelPath
	found := false
	for start, l := range lines {
		if !q.Steps[0].matches(l) {
			continue
		}
		at := []time.Time{l.Time}
		for _, next := range lines[start+1:] {
			if len(at) == len(q.Steps) {
				break
			}
			if q.Within > 0 && next.Time.Sub(at[0]) > q.Within {
				break
			}
			if q.Steps[len(at)].matches(next) {
				at = append(at, next.Time)
			}
		}
		if !found || len(at) > best.reached {
			best = funnelPath{reached: len(at), at: at}
			found = true
		}
		if best.reached == len(q.Steps) {
			break
		}
	}
	if !found {
		return funnelPath{}, false
	}
	for _, l := range lines {
		if u := userOf(l.Labels); u != "" {
			best.user = u
		}
		if p, ok := navPath(l.Labels); ok && p != "" {
			best.lastPath = p
		}
	}
	best.session = lines[0].Labels["session_id"]
	return best, true
}

// sortLines orders records by time, then event name, then body (stable, total).
func sortLines(ls []LokiLine) {
	sort.SliceStable(ls, func(i, j int) bool {
		if !ls[i].Time.Equal(ls[j].Time) {
			return ls[i].Time.Before(ls[j].Time)
		}
		if a, b := ls[i].Labels["event_name"], ls[j].Labels["event_name"]; a != b {
			return a < b
		}
		return ls[i].Body < ls[j].Body
	})
}

// bySession groups records by session id (records without one are dropped) and sorts
// each group.
func bySession(lines []LokiLine) map[string][]LokiLine {
	by := map[string][]LokiLine{}
	for _, l := range lines {
		if id := l.Labels["session_id"]; id != "" {
			by[id] = append(by[id], l)
		}
	}
	for _, own := range by {
		sortLines(own)
	}
	return by
}

func funnelPaths(q *FunnelQuery, lines []LokiLine) []funnelPath {
	var out []funnelPath
	for _, own := range bySession(lines) {
		if p, ok := walk(q, own); ok {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].session < out[j].session })
	return out
}

func funnelReport(q *FunnelQuery, paths []funnelPath) []FunnelStepResult {
	rows := make([]FunnelStepResult, len(q.Steps))
	for i, s := range q.Steps {
		users := map[string]bool{}
		var gaps []int64
		n := 0
		for _, p := range paths {
			if p.reached <= i {
				continue
			}
			n++
			if p.user != "" {
				users[p.user] = true
			}
			if i > 0 {
				gaps = append(gaps, p.at[i].Sub(p.at[i-1]).Milliseconds())
			}
		}
		rows[i] = FunnelStepResult{Step: s, Label: s.String(), Sessions: n, Users: len(users)}
		if i > 0 {
			prev := rows[i-1].Sessions
			rows[i].DroppedOff = prev - n
			rows[i].ConversionFromPrevious = pct2(n, prev)
			rows[i].MedianMs, rows[i].P75Ms = nearestRank(gaps, 0.5), nearestRank(gaps, 0.75)
		}
		rows[i].ConversionFromFirst = pct2(n, rows[0].Sessions)
	}
	return rows
}

// dropped returns the paths that reached step-1 but not step (1-based), latest drop first.
func dropped(paths []funnelPath, step int) []funnelPath {
	var out []funnelPath
	for _, p := range paths {
		if p.reached == step-1 {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].at[len(out[i].at)-1], out[j].at[len(out[j].at)-1]
		if !a.Equal(b) {
			return a.After(b)
		}
		return out[i].session < out[j].session
	})
	return out
}

// pct2 is n/of as a percentage with 2 decimals, 0 when of is 0.
func pct2(n, of int) float64 {
	if of == 0 {
		return 0
	}
	return float64(int64(float64(n)*10000/float64(of)+0.5)) / 100
}

// nearestRank is the nearest-rank quantile; nil for no values.
func nearestRank(v []int64, q float64) *int64 {
	if len(v) == 0 {
		return nil
	}
	s := append([]int64(nil), v...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	rank := int(q*float64(len(s)) + 0.999999999)
	rank = min(max(rank, 1), len(s))
	x := s[rank-1]
	return &x
}

// funnelQueries returns one LogQL query per step kind present: navigation records
// narrowed to the step paths, and the step event names.
func funnelQueries(q *FunnelQuery) []string {
	var paths, names []string
	seen := map[string]bool{}
	for _, st := range q.Steps {
		if seen[st.String()] {
			continue
		}
		seen[st.String()] = true
		switch st.Kind {
		case StepPage:
			p := regexp.QuoteMeta(st.Value)
			if st.Match == MatchPrefix {
				p += ".*"
			}
			paths = append(paths, p)
		case StepEvent:
			names = append(names, regexp.QuoteMeta(st.Value))
		}
	}
	var out []string
	if len(paths) > 0 {
		alt := strings.Join(paths, "|")
		// url.path (mobile) or the path part of url.full (web); Go re-checks the match,
		// so the url.full pattern only has to let every match through.
		out = append(out, q.Filters.selector(`=~"navigation|browser[.]navigation"`)+
			` | url_path=~`+strconv.Quote(alt)+` or url_full=~`+strconv.Quote(`[^/]*//[^/]*(`+alt+`)([?#].*)?`))
	}
	if len(names) > 0 {
		out = append(out, q.Filters.selector(`=~`+strconv.Quote(strings.Join(names, "|"))))
	}
	return out
}

// queryAll pages a forward log query: when a page is full it continues from the last
// timestamp (inclusive; duplicates are dropped), up to FunnelEventLimit records.
func (l *Loki) queryAll(ctx context.Context, logql string, from, to time.Time) ([]LokiLine, bool, error) {
	page := orDefault(l.EventLimit, 5000)
	total := orDefault(l.FunnelEventLimit, 100_000)
	var all []LokiLine
	seen := map[string]bool{}
	cursor := from
	for len(all) < total {
		lines, err := l.QueryRange(ctx, logql, cursor, to, page, false)
		if err != nil {
			return nil, false, err
		}
		for _, line := range lines {
			k := strconv.FormatInt(line.Time.UnixNano(), 10) + "|" + line.Labels["session_id"] + "|" + line.Labels["event_name"] + "|" + line.Body
			if !seen[k] {
				seen[k] = true
				all = append(all, line)
			}
		}
		if len(lines) < page {
			return all, false, nil
		}
		last := lines[len(lines)-1].Time
		if !last.After(cursor) {
			last = cursor.Add(time.Nanosecond)
		}
		cursor = last
	}
	return all, true, nil
}

func (l *Loki) funnel(ctx context.Context, q *FunnelQuery) ([]funnelPath, time.Time, time.Time, bool, error) {
	if err := q.check(); err != nil {
		return nil, time.Time{}, time.Time{}, false, err
	}
	from, to, err := q.window(l.Now)
	if err != nil {
		return nil, from, to, false, err
	}
	queries := funnelQueries(q)
	results := make([][]LokiLine, len(queries))
	truncated := make([]bool, len(queries))
	errs := make([]error, len(queries))
	var wg sync.WaitGroup
	for i, lq := range queries {
		wg.Go(func() { results[i], truncated[i], errs[i] = l.queryAll(ctx, lq, from, to) })
	}
	wg.Wait()
	var all []LokiLine
	trunc := false
	for i := range queries {
		if errs[i] != nil {
			return nil, from, to, false, errs[i]
		}
		all = append(all, results[i]...)
		trunc = trunc || truncated[i]
	}
	return funnelPaths(q, all), from, to, trunc, nil
}

// Funnel reports how many sessions reached each step, in order, within the range.
func (l *Loki) Funnel(ctx context.Context, q FunnelQuery) (*FunnelReport, error) {
	paths, from, to, trunc, err := l.funnel(ctx, &q)
	if err != nil {
		return nil, err
	}
	rows := funnelReport(&q, paths)
	r := &FunnelReport{Steps: rows, Sessions: rows[0].Sessions, Users: rows[0].Users, From: from, To: to, Truncated: trunc}
	if q.Within > 0 {
		ms := q.Within.Milliseconds()
		r.WithinMs = &ms
	}
	return r, nil
}

// FunnelDropped lists the sessions that reached step-1 but not step (1-based,
// 2..len(steps)), latest drop first, limit (default 50, at most 500) from offset.
func (l *Loki) FunnelDropped(ctx context.Context, q FunnelQuery, step, offset, limit int) (*FunnelDropped, error) {
	if step < 2 || step > len(q.Steps) {
		return nil, &BadRequestError{Msg: fmt.Sprintf("step must be between 2 and %d", max(len(q.Steps), 2))}
	}
	if offset < 0 || limit < 0 {
		return nil, &BadRequestError{Msg: "offset and limit must not be negative"}
	}
	limit = min(orDefault(limit, 50), 500)
	paths, from, to, trunc, err := l.funnel(ctx, &q)
	if err != nil {
		return nil, err
	}
	drops := dropped(paths, step)
	out := &FunnelDropped{Step: step, Sessions: []DroppedSession{}, Total: len(drops), Offset: offset, Limit: limit, From: from, To: to, Truncated: trunc}
	end := min(offset+limit, len(drops))
	for _, p := range drops[min(offset, len(drops)):end] {
		out.Sessions = append(out.Sessions, DroppedSession{SessionID: p.session, User: p.user, EnteredAt: p.at[0], LastStepAt: p.at[len(p.at)-1], LastPath: p.lastPath})
	}
	if end < len(drops) {
		out.NextOffset = &end
	}
	return out, nil
}

// reservedEvents are the event names the SDKs emit themselves; any other event name is a
// custom event (recordEvent). The mobile SDKs also mark theirs ouo.event.custom=true.
const reservedEvents = `(session|ouo|browser|app|device)[.].*|exception|navigation|web_vital|http[.]request[.]failed`

// FunnelSteps lists the page paths and custom event names seen in the range with their
// record counts, most frequent first (at most 200 each), for a step builder's
// autocomplete. A non-empty contains keeps the values that contain it.
func (l *Loki) FunnelSteps(ctx context.Context, f Filters, r TimeRange, contains string) (*StepSuggestions, error) {
	if err := f.check(); err != nil {
		return nil, err
	}
	from, to, err := r.window(l.Now)
	if err != nil {
		return nil, err
	}
	queries := []struct{ q, by string }{
		{f.selector(`="navigation"`), "url_path"},
		{f.selector(`="browser.navigation"`), "url_full"},
		{f.selector(`=~".+"`) + ` | ouo_event_custom="true" or event_name!~"` + reservedEvents + `"`, "event_name"},
	}
	counts := make([]map[string]int, len(queries))
	errs := make([]error, len(queries))
	var wg sync.WaitGroup
	for i, c := range queries {
		wg.Go(func() { counts[i], errs[i] = l.counts(ctx, c.q, c.by, from, to) })
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	pages := counts[0]
	for full, n := range counts[1] {
		if p, ok := navPath(map[string]string{"event_name": browserNavigationEvent, "url_full": full}); ok {
			pages[p] += n
		}
	}
	return &StepSuggestions{Pages: rankValues(pages, contains), Events: rankValues(counts[2], contains), From: from, To: to}, nil
}

// counts runs sum by (<by>) (count_over_time(<query> [<range>])) at to.
func (l *Loki) counts(ctx context.Context, logql, by string, from, to time.Time) (map[string]int, error) {
	secs := max(int64(to.Sub(from).Seconds()), 1)
	series, err := l.queryVector(ctx, fmt.Sprintf("sum by (%s) (count_over_time(%s [%ds]))", by, logql, secs), to)
	if err != nil {
		return nil, err
	}
	out := map[string]int{}
	for _, s := range series {
		k := s.Metric[by]
		n, err := strconv.ParseFloat(s.value(), 64)
		if k == "" || err != nil {
			continue
		}
		out[k] += int(n)
	}
	return out, nil
}

func rankValues(m map[string]int, contains string) []StepSuggestion {
	out := []StepSuggestion{}
	for v, n := range m {
		if contains == "" || strings.Contains(v, contains) {
			out = append(out, StepSuggestion{Value: v, Count: n})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Value < out[j].Value
	})
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}
