package ouogo

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Funnels (docs/specs/funnels.md, ADR-0025): of the sessions that did step 1, how many then did
// step 2, then step 3, and of those that stopped, how many stopped because the app failed. The
// rules are the MVP engine's (ADR-0012, ordering, attempts, window) and PR #168's conditions
// and failed outcome, moved onto the spec wire: a page step matches the web SDK's
// browser.navigation (path of url.full) and the mobile SDK's navigation (url.path, the screen),
// so one funnel counts web and mobile sessions together.

// Limits of a funnel.
const (
	FunnelMinSteps      = 2
	FunnelMaxSteps      = 10
	FunnelMaxValueLen   = 256
	FunnelMaxConditions = 5
	FunnelMaxWithin     = 7 * 24 * time.Hour
)

// Step kinds.
const (
	StepPage  = "page"  // a page (web) or screen (mobile) path
	StepEvent = "event" // any other event, by event.name, with optional conditions
)

// Condition operators.
const (
	OpEq    = "="
	OpNeq   = "!="
	OpRegex = "=~" // RE2, fully anchored
)

// Condition is one `key op value` test on an event attribute. A missing attribute reads as "".
type Condition struct {
	// Key is the attribute name as the SDK sends it (payment.method); compared under its Loki
	// name (payment_method).
	Key   string `json:"key"`
	Op    string `json:"op,omitempty"` // default =
	Value string `json:"value"`

	re *regexp.Regexp
}

var reCondKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.\-]{0,127}$`)

func lokiKey(k string) string {
	return strings.Map(func(r rune) rune {
		if r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, k)
}

func (c *Condition) validate() error {
	if !reCondKey.MatchString(c.Key) {
		return fmt.Errorf("condition key %q: want an attribute name (letters, digits, _ . -, at most 128)", c.Key)
	}
	if k := lokiKey(c.Key); k == "event_name" || coreKeys[k] && k != "severity_text" {
		return fmt.Errorf("condition key %q is part of the step itself", c.Key)
	}
	if len(c.Value) > FunnelMaxValueLen || !utf8.ValidString(c.Value) || strings.IndexFunc(c.Value, unicode.IsControl) >= 0 {
		return fmt.Errorf("condition %s: value must be printable UTF-8, at most %d bytes", c.Key, FunnelMaxValueLen)
	}
	switch c.Op {
	case "":
		c.Op = OpEq
	case OpEq, OpNeq:
	case OpRegex:
		re, err := regexp.Compile(`^(?:` + c.Value + `)$`)
		if err != nil || c.Value == "" {
			return fmt.Errorf("condition %s =~: want a regular expression", c.Key)
		}
		c.re = re
	default:
		return fmt.Errorf("condition %s: operator must be =, != or =~", c.Key)
	}
	return nil
}

func (c Condition) matches(labels map[string]string) bool {
	v := labels[lokiKey(c.Key)]
	switch c.Op {
	case OpNeq:
		return v != c.Value
	case OpRegex:
		return c.re != nil && c.re.MatchString(v)
	}
	return v == c.Value
}

// FunnelStep is one step. A page value starts with "/"; with Prefix it matches every path under
// it. An event step names an event (not a navigation) and may carry conditions.
type FunnelStep struct {
	Kind   string      `json:"kind"`
	Value  string      `json:"value"`
	Prefix bool        `json:"prefix,omitempty"`
	Where  []Condition `json:"where,omitempty"`
	// Label is what the UI shows; the compact form when empty.
	Label string `json:"label,omitempty"`
}

// navigationEvents are the page and screen changes of the SDKs: browser.navigation carries
// url.full (web), navigation carries url.path (mobile screens, the MVP web SDK).
var navigationEvents = map[string]bool{"browser.navigation": true, "navigation": true}

func (s *FunnelStep) validate() error {
	if s.Value == "" || len(s.Value) > FunnelMaxValueLen || !utf8.ValidString(s.Value) {
		return fmt.Errorf("step value must be 1 to %d bytes of UTF-8", FunnelMaxValueLen)
	}
	switch s.Kind {
	case StepPage:
		if !strings.HasPrefix(s.Value, "/") {
			return fmt.Errorf("page step %q must start with /", s.Value)
		}
		if len(s.Where) > 0 {
			return fmt.Errorf("page step %q takes no conditions", s.Value)
		}
	case StepEvent:
		if navigationEvents[s.Value] {
			return fmt.Errorf("event step %q: use a page step for navigations", s.Value)
		}
		if strings.ContainsAny(s.Value, "\"\\`|") {
			return fmt.Errorf("event step %q: name has a character LogQL would need escaped", s.Value)
		}
		if len(s.Where) > FunnelMaxConditions {
			return fmt.Errorf("event step %q: at most %d conditions", s.Value, FunnelMaxConditions)
		}
		for i := range s.Where {
			if err := s.Where[i].validate(); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("step kind must be page or event, got %q", s.Kind)
	}
	if s.Label == "" {
		s.Label = s.String()
	}
	return nil
}

// String is the compact form: page:/cart, page:/products/* (prefix), event:pay where method=card.
func (s FunnelStep) String() string {
	v := s.Value
	if s.Kind == StepPage && s.Prefix {
		v += "*"
	}
	out := s.Kind + ":" + v
	for i, c := range s.Where {
		sep := " and "
		if i == 0 {
			sep = " where "
		}
		op := c.Op
		if op == "" {
			op = OpEq
		}
		out += sep + c.Key + op + strconv.Quote(c.Value)
	}
	return out
}

// eventPath is the path a navigation record names: url.path (mobile), else the path of url.full
// (web). "" for anything else.
func eventPath(labels map[string]string) string {
	if !navigationEvents[labels["event_name"]] {
		return ""
	}
	if p := labels["url_path"]; p != "" {
		return p
	}
	if u, err := url.Parse(labels["url_full"]); err == nil && u.Path != "" {
		return u.Path
	}
	return ""
}

func (s FunnelStep) matches(labels map[string]string) bool {
	if s.Kind == StepPage {
		p := eventPath(labels)
		if p == "" {
			return false
		}
		if s.Prefix {
			return strings.HasPrefix(p, s.Value)
		}
		return p == s.Value
	}
	if labels["event_name"] != s.Value {
		return false
	}
	for _, c := range s.Where {
		if !c.matches(labels) {
			return false
		}
	}
	return true
}

// Funnel is a definition: ordered steps, an optional conversion window and the failure event.
type Funnel struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Description string       `json:"description,omitempty"`
	Steps       []FunnelStep `json:"steps"`
	// WithinSeconds bounds the time from step 1 to every later step of an attempt; 0 is unbounded.
	WithinSeconds int64 `json:"within_seconds,omitempty"`
	// Failure marks sessions that stopped because something broke. Nil means exception; set
	// NoFailure to turn it off.
	Failure   *FunnelStep `json:"failure,omitempty"`
	NoFailure bool        `json:"no_failure,omitempty"`
	// Project restricts the funnel to one project; empty is every project the caller sees.
	Project string `json:"project,omitempty"`
}

var reFunnelID = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// Validate checks a definition and fills defaults (labels, the exception failure event).
func (f *Funnel) Validate() error {
	if !reFunnelID.MatchString(f.ID) {
		return fmt.Errorf("funnel id %q must match %s", f.ID, reFunnelID)
	}
	if f.Name == "" {
		f.Name = f.ID
	}
	if n := len(f.Steps); n < FunnelMinSteps || n > FunnelMaxSteps {
		return fmt.Errorf("funnel %s: %d to %d steps, got %d", f.ID, FunnelMinSteps, FunnelMaxSteps, n)
	}
	for i := range f.Steps {
		if err := f.Steps[i].validate(); err != nil {
			return fmt.Errorf("funnel %s step %d: %w", f.ID, i+1, err)
		}
	}
	if f.WithinSeconds < 0 || time.Duration(f.WithinSeconds)*time.Second > FunnelMaxWithin {
		return fmt.Errorf("funnel %s: within must be 0 to %s", f.ID, FunnelMaxWithin)
	}
	if f.Project != "" {
		if err := checkProject(f.Project); err != nil {
			return err
		}
	}
	switch {
	case f.NoFailure:
		f.Failure = nil
	case f.Failure == nil:
		f.Failure = &FunnelStep{Kind: StepEvent, Value: "exception"}
	}
	if f.Failure != nil {
		f.Failure.Kind = StepEvent
		if err := f.Failure.validate(); err != nil {
			return fmt.Errorf("funnel %s failure: %w", f.ID, err)
		}
	}
	return nil
}

// ValidateFunnels checks a list of definitions and that ids are unique.
func ValidateFunnels(fs []Funnel) error {
	seen := map[string]bool{}
	for i := range fs {
		if err := fs[i].Validate(); err != nil {
			return err
		}
		if seen[fs[i].ID] {
			return fmt.Errorf("funnel id %q is used twice", fs[i].ID)
		}
		seen[fs[i].ID] = true
	}
	return nil
}

// FunnelRecord is one record a funnel reads: the Loki labels of one line and its time.
type FunnelRecord struct {
	Time   time.Time
	Labels map[string]string
}

// FunnelPath is how far one session got on its credited attempt.
type FunnelPath struct {
	Project  string
	Session  string
	Platform string
	User     string
	// Reached is the number of steps reached (1..len(steps)).
	Reached int
	// At[i] is when step i+1 was reached.
	At []time.Time
	// Failed: the session stopped (Reached < len(steps)) and a failure event followed its last
	// step. FailedWith is that event's name.
	Failed     bool
	FailedWith string
}

// Outcomes of a session that stopped.
const (
	OutcomeFailed    = "failed"
	OutcomeAbandoned = "abandoned"
)

// WalkFunnel computes one session's path from its records in time order. Steps must be hit in
// order; other records in between are ignored and a repeated step counts once. Every occurrence
// of step 1 is tried as a start; the deepest path wins, the earliest start on ties. ok is false
// when the session never hit step 1. f must be validated.
func WalkFunnel(f Funnel, recs []FunnelRecord) (p FunnelPath, ok bool) {
	within := time.Duration(f.WithinSeconds) * time.Second
	bestStart := -1
	var bestIdx []int
	for start, r := range recs {
		if !f.Steps[0].matches(r.Labels) {
			continue
		}
		idx := []int{start}
		for j := start + 1; j < len(recs) && len(idx) < len(f.Steps); j++ {
			if within > 0 && recs[j].Time.Sub(r.Time) > within {
				break
			}
			if f.Steps[len(idx)].matches(recs[j].Labels) {
				idx = append(idx, j)
			}
		}
		if bestStart < 0 || len(idx) > len(bestIdx) {
			bestStart, bestIdx = start, idx
		}
		if len(bestIdx) == len(f.Steps) {
			break
		}
	}
	if bestStart < 0 {
		return FunnelPath{}, false
	}
	p.Reached = len(bestIdx)
	for _, i := range bestIdx {
		p.At = append(p.At, recs[i].Time)
	}
	// Failed: a failure event at or after the last step's record (that record excepted), inside
	// the window of step 1 when one is set.
	if f.Failure != nil && p.Reached < len(f.Steps) {
		last := bestIdx[len(bestIdx)-1]
		for j := last + 1; j < len(recs); j++ {
			if within > 0 && recs[j].Time.Sub(p.At[0]) > within {
				break
			}
			if f.Failure.matches(recs[j].Labels) {
				p.Failed, p.FailedWith = true, recs[j].Labels["event_name"]
				break
			}
		}
	}
	for _, r := range recs {
		l := r.Labels
		if p.Project == "" {
			p.Project, p.Session, p.Platform = l["ouo_project_id"], l["session_id"], PlatformOf(l)
		}
		if u := userOf(l); u != "" {
			p.User = u
		}
	}
	return p, true
}

func userOf(labels map[string]string) string {
	// enduser.id from the SDKs (setUser); user.id from the Sentry bridge.
	for _, k := range []string{"enduser_id", "user_id"} {
		if u := labels[k]; u != "" {
			return u
		}
	}
	return ""
}

// FunnelPaths groups records by (project, session), sorts each session's records and walks them.
// Records without a session id are dropped. The answer is sorted by project and session.
func FunnelPaths(f Funnel, recs []FunnelRecord) []FunnelPath {
	by := map[[2]string][]FunnelRecord{}
	for _, r := range recs {
		s := r.Labels["session_id"]
		if s == "" {
			continue
		}
		k := [2]string{r.Labels["ouo_project_id"], s}
		by[k] = append(by[k], r)
	}
	out := make([]FunnelPath, 0, len(by))
	for _, own := range by {
		sort.SliceStable(own, func(i, j int) bool { return own[i].Time.Before(own[j].Time) })
		if p, ok := WalkFunnel(f, own); ok {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Project != out[j].Project {
			return out[i].Project < out[j].Project
		}
		return out[i].Session < out[j].Session
	})
	return out
}

// FunnelStepResult is one row of a report.
type FunnelStepResult struct {
	Step     FunnelStep `json:"step"`
	Sessions int        `json:"sessions"`
	// ByPlatform splits Sessions by ouo.platform (web, ios, android, ...).
	ByPlatform map[string]int `json:"by_platform"`
	// Conversion from step 1 and from the previous step, percent with two decimals.
	ConversionFromFirst    float64 `json:"conversion_from_first"`
	ConversionFromPrevious float64 `json:"conversion_from_previous"`
	// DroppedOff: sessions that reached the previous step but not this one (0 for step 1);
	// Failed is the part of them whose outcome is failed.
	DroppedOff int `json:"dropped_off"`
	Failed     int `json:"failed"`
	// FailureRate: Failed as a percentage of the previous step's sessions.
	FailureRate float64 `json:"failure_rate"`
	// MedianMs and P75Ms: time from the previous step over the sessions that reached this one.
	MedianMs *int64 `json:"median_ms"`
	P75Ms    *int64 `json:"p75_ms"`
}

// FunnelReportOf aggregates paths into one row per step.
func FunnelReportOf(f Funnel, paths []FunnelPath) []FunnelStepResult {
	rows := make([]FunnelStepResult, len(f.Steps))
	for i, s := range f.Steps {
		row := FunnelStepResult{Step: s, ByPlatform: map[string]int{}}
		var gaps []int64
		for _, p := range paths {
			if p.Reached == i && p.Failed {
				row.Failed++
			}
			if p.Reached <= i {
				continue
			}
			row.Sessions++
			row.ByPlatform[platformOr(p.Platform)]++
			if i > 0 {
				gaps = append(gaps, p.At[i].Sub(p.At[i-1]).Milliseconds())
			}
		}
		if i > 0 {
			prev := rows[i-1].Sessions
			row.DroppedOff = prev - row.Sessions
			row.ConversionFromPrevious = pct(row.Sessions, prev)
			row.FailureRate = pct(row.Failed, prev)
			row.MedianMs, row.P75Ms = quantile(gaps, 0.5), quantile(gaps, 0.75)
		} else {
			row.Failed = 0
		}
		rows[i] = row
		rows[i].ConversionFromFirst = pct(row.Sessions, rows[0].Sessions)
	}
	return rows
}

func platformOr(p string) string {
	if p == "" {
		return "unknown"
	}
	return p
}

// PlatformOf names a record's platform: ouo.platform when the producer set it (the mobile SDK,
// the Sentry bridge), else web for the browser SDK's records (it sets no ouo.platform; it sends
// telemetry.sdk.name and browser.* attributes), else the OS name, else unknown.
func PlatformOf(labels map[string]string) string {
	if p := labels["ouo_platform"]; p != "" {
		return p
	}
	if strings.Contains(labels["telemetry_sdk_name"], "browser") || labels["browser_document_url_full"] != "" || labels["browser_platform"] != "" {
		return "web"
	}
	switch os := strings.ToLower(labels["os_name"]); os {
	case "ios", "ipados":
		return "ios"
	case "android":
		return "android"
	}
	return "unknown"
}

func pct(n, of int) float64 {
	if of == 0 {
		return 0
	}
	return float64(int64(float64(n)*10000/float64(of)+0.5)) / 100
}

// quantile is the nearest-rank quantile; nil for no values.
func quantile(v []int64, q float64) *int64 {
	if len(v) == 0 {
		return nil
	}
	s := append([]int64(nil), v...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	rank := min(max(int(q*float64(len(s))+0.999999999), 1), len(s))
	x := s[rank-1]
	return &x
}

// FunnelQuery runs one funnel.
type FunnelQuery struct {
	TimeRange
	Project  string // empty: the funnel's project, else every project the caller sees
	Platform string // empty: every platform
}

// FunnelReport is the answer of RunFunnel: counts only, visible from c1.
type FunnelReport struct {
	Funnel Funnel             `json:"funnel"`
	From   int64              `json:"from"`
	To     int64              `json:"to"`
	Steps  []FunnelStepResult `json:"steps"`
	// Truncated: a read hit FunnelLimit, so the end of the range is undercounted.
	Truncated bool `json:"truncated"`
}

// DroppedSession is one session that stopped before a step.
type DroppedSession struct {
	Project  string `json:"project"`
	ID       string `json:"id"`
	Platform string `json:"platform"`
	// LastStepAt is when the session reached the step before (ms since the epoch).
	LastStepAt int64  `json:"last_step_at"`
	Outcome    string `json:"outcome"`
	FailedWith string `json:"failed_with,omitempty"`
	// User needs Identity clearance in the session's project.
	User string `json:"user,omitempty"`
}

// DroppedList is the answer of FunnelDropped.
type DroppedList struct {
	Step      int              `json:"step"`
	Outcome   string           `json:"outcome,omitempty"`
	Sessions  []DroppedSession `json:"sessions"`
	Total     int              `json:"total"`
	Truncated bool             `json:"truncated"`
	Redacted  []string         `json:"redacted"`
}

// funnelRead reads the records a validated funnel needs, one Loki query per kind (navigations; named
// events and the failure event), dropping projects the caller does not see.
func (c *Client) funnelRead(ctx context.Context, cl Clearance, f Funnel, q FunnelQuery) ([]FunnelPath, bool, time.Time, time.Time, error) {
	if !cl.Max().Can().Timeline {
		return nil, false, time.Time{}, time.Time{}, ErrForbidden
	}
	from, to, err := c.window(q.TimeRange)
	if err != nil {
		return nil, false, from, to, err
	}
	project := q.Project
	if project == "" {
		project = f.Project
	}
	sel := `ouo_project_id=~".+"`
	if project != "" {
		if err := checkProject(project); err != nil {
			return nil, false, from, to, err
		}
		sel = `ouo_project_id="` + project + `"`
	}
	if q.Platform != "" {
		if err := checkProject(q.Platform); err != nil {
			return nil, false, from, to, &BadRequestError{Msg: "platform must match ^[a-z0-9][a-z0-9._-]{0,63}$"}
		}
	}
	var names []string
	seen := map[string]bool{}
	pages := false
	steps := f.Steps
	if f.Failure != nil {
		steps = append(append([]FunnelStep(nil), f.Steps...), *f.Failure)
	}
	for _, s := range steps {
		if s.Kind == StepPage {
			pages = true
		} else if !seen[s.Value] {
			seen[s.Value] = true
			names = append(names, regexp.QuoteMeta(s.Value))
		}
	}
	var queries []string
	if pages {
		queries = append(queries, `{`+sel+`, event_name=~"browser[.]navigation|navigation"} | session_id != ""`)
	}
	if len(names) > 0 {
		queries = append(queries, `{`+sel+`, event_name=~"`+strings.ReplaceAll(strings.Join(names, "|"), `\`, `\\`)+`"} | session_id != ""`)
	}
	limit := orDefault(c.FunnelLimit, 5000)
	var recs []FunnelRecord
	truncated := false
	for _, lq := range queries {
		lines, err := c.Loki.queryRange(ctx, lq, from, to, limit, false)
		if err != nil {
			return nil, false, from, to, err
		}
		truncated = truncated || len(lines) >= limit
		for _, l := range lines {
			if !cl.For(l.Labels["ouo_project_id"]).Can().Timeline || q.Platform != "" && PlatformOf(l.Labels) != q.Platform {
				continue
			}
			recs = append(recs, FunnelRecord{Time: l.Time, Labels: l.Labels})
		}
	}
	return FunnelPaths(f, recs), truncated, from, to, nil
}

// RunFunnel computes a funnel report. Counts are timeline-level: c1 in at least one project.
// Sessions of projects the caller sees at level 0 are not counted.
func (c *Client) RunFunnel(ctx context.Context, cl Clearance, f Funnel, q FunnelQuery) (*FunnelReport, error) {
	if err := f.Validate(); err != nil {
		return nil, &BadRequestError{Msg: err.Error()}
	}
	paths, truncated, from, to, err := c.funnelRead(ctx, cl, f, q)
	if err != nil {
		return nil, err
	}
	return &FunnelReport{Funnel: f, From: from.UnixMilli(), To: to.UnixMilli(), Steps: FunnelReportOf(f, paths), Truncated: truncated}, nil
}

// FunnelDropped lists the sessions that reached step-1 but not step (1-based, 2..len(steps)),
// latest drop first; outcome "" is both, else failed or abandoned. Session ids are timeline-level
// (c1); the user needs Identity clearance in the session's project.
func (c *Client) FunnelDropped(ctx context.Context, cl Clearance, f Funnel, q FunnelQuery, step int, outcome string, limit int) (*DroppedList, error) {
	if outcome != "" && outcome != OutcomeFailed && outcome != OutcomeAbandoned {
		return nil, &BadRequestError{Msg: "outcome must be failed or abandoned"}
	}
	if err := f.Validate(); err != nil {
		return nil, &BadRequestError{Msg: err.Error()}
	}
	paths, truncated, _, _, err := c.funnelRead(ctx, cl, f, q)
	if err != nil {
		return nil, err
	}
	if step < 2 || step > len(f.Steps) {
		return nil, &BadRequestError{Msg: fmt.Sprintf("step must be 2 to %d", len(f.Steps))}
	}
	out := &DroppedList{Step: step, Outcome: outcome, Sessions: []DroppedSession{}, Truncated: truncated}
	redacted := map[string]bool{}
	for _, p := range paths {
		if p.Reached != step-1 {
			continue
		}
		o := OutcomeAbandoned
		if p.Failed {
			o = OutcomeFailed
		}
		if outcome != "" && o != outcome {
			continue
		}
		pc := cl.For(p.Project)
		d := DroppedSession{Project: p.Project, ID: p.Session, Platform: p.Platform, LastStepAt: p.At[len(p.At)-1].UnixMilli(), Outcome: o, FailedWith: p.FailedWith}
		if pc.Can().Identity {
			d.User = p.User
		} else {
			redacted[GroupIdentity] = true
		}
		out.Sessions = append(out.Sessions, d)
	}
	sort.SliceStable(out.Sessions, func(i, j int) bool { return out.Sessions[i].LastStepAt > out.Sessions[j].LastStepAt })
	out.Total = len(out.Sessions)
	if n := orDefault(limit, 50); n > 0 && len(out.Sessions) > min(n, 500) {
		out.Sessions = out.Sessions[:min(n, 500)]
	}
	out.Redacted = []string{}
	if redacted[GroupIdentity] {
		out.Redacted = append(out.Redacted, GroupIdentity)
	}
	return out, nil
}

// FindFunnel returns the definition with this id, or ErrNotFound.
func FindFunnel(fs []Funnel, id string) (Funnel, error) {
	for _, f := range fs {
		if f.ID == id {
			return f, nil
		}
	}
	return Funnel{}, fmt.Errorf("%w: %s", ErrNotFound, id)
}
