// Package funnel computes funnel reports (docs/specs/funnels.md, ADR-0012):
// how many sessions reach each of an ordered list of steps, where a step is a
// page path (navigation events) or a custom event name. Everything in this
// package is pure: the caller fetches the events from Loki.
package funnel

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// Limits of one funnel query.
const (
	MinSteps    = 2
	MaxSteps    = 10
	MaxValueLen = 256
	MaxWithin   = 7 * 24 * time.Hour
	MaxRange    = 31 * 24 * time.Hour
)

// Kind is what a step matches.
type Kind string

const (
	KindPage  Kind = "page"  // url_path of a navigation event
	KindEvent Kind = "event" // event_name of any other event (rum.addEvent)
)

// Match is how a page step compares the path.
type Match string

const (
	MatchExact  Match = "exact"
	MatchPrefix Match = "prefix"
)

// NavigationEvent is the event_name of page and route changes.
const NavigationEvent = "navigation"

// PathAttr is the Loki name of url.path on navigation events.
const PathAttr = "url_path"

// Step is one funnel step.
type Step struct {
	Kind  Kind   `json:"kind"`
	Match Match  `json:"match,omitempty"` // page steps; default exact
	Value string `json:"value"`           // path or event name
}

// Matches reports whether ev satisfies the step.
func (s Step) Matches(ev session.Event) bool {
	switch s.Kind {
	case KindPage:
		if ev.Name != NavigationEvent {
			return false
		}
		p := ev.Attrs[PathAttr]
		if s.Match == MatchPrefix {
			return strings.HasPrefix(p, s.Value)
		}
		return p == s.Value
	case KindEvent:
		return ev.Name == s.Value && ev.Name != NavigationEvent
	}
	return false
}

// String is the compact form used in URLs: page:/cart, page:/products/*
// (prefix), event:add_to_cart.
func (s Step) String() string {
	v := s.Value
	if s.Kind == KindPage && s.Match == MatchPrefix {
		v += "*"
	}
	return string(s.Kind) + ":" + v
}

// ParseStep reads the compact form of String.
func ParseStep(v string) (Step, error) {
	kind, val, ok := strings.Cut(v, ":")
	if !ok {
		return Step{}, fmt.Errorf("step %q: want page:<path> or event:<name>", v)
	}
	s := Step{Kind: Kind(kind), Value: val}
	if s.Kind == KindPage {
		s.Match = MatchExact
		if strings.HasSuffix(val, "*") {
			s.Match, s.Value = MatchPrefix, strings.TrimSuffix(val, "*")
		}
	}
	return s, s.Validate()
}

// Validate checks one step and fills the default match.
func (s *Step) Validate() error {
	if s.Value == "" || len(s.Value) > MaxValueLen {
		return fmt.Errorf("step value must be 1 to %d characters", MaxValueLen)
	}
	switch s.Kind {
	case KindPage:
		if s.Match == "" {
			s.Match = MatchExact
		}
		if s.Match != MatchExact && s.Match != MatchPrefix {
			return fmt.Errorf("step %q: match must be exact or prefix", s.Value)
		}
		if !strings.HasPrefix(s.Value, "/") {
			return fmt.Errorf("page step %q must start with /", s.Value)
		}
	case KindEvent:
		if s.Match != "" && s.Match != MatchExact {
			return fmt.Errorf("event step %q: only exact match", s.Value)
		}
		s.Match = ""
		if s.Value == NavigationEvent {
			return errors.New("event step cannot be navigation: use a page step")
		}
	default:
		return fmt.Errorf("step kind must be page or event, got %q", s.Kind)
	}
	return nil
}

// Definition is the funnel: ordered steps and an optional conversion window.
type Definition struct {
	Steps []Step
	// Within bounds the time from step 1 to the last reached step; 0 is
	// unbounded (the query range still bounds it).
	Within time.Duration
}

// Validate checks the definition.
func (d *Definition) Validate() error {
	if len(d.Steps) < MinSteps || len(d.Steps) > MaxSteps {
		return fmt.Errorf("a funnel has %d to %d steps", MinSteps, MaxSteps)
	}
	for i := range d.Steps {
		if err := d.Steps[i].Validate(); err != nil {
			return err
		}
	}
	if d.Within < 0 || d.Within > MaxWithin {
		return fmt.Errorf("within must be between 0 and %s", MaxWithin)
	}
	return nil
}

// Path is how far one session got.
type Path struct {
	SessionID string
	UserID    string
	// Reached is the number of steps reached (1..len(steps)); sessions that
	// never hit step 1 have no Path.
	Reached int
	// At[i] is when step i was reached.
	At []time.Time
	// LastPath is the session's last url_path seen in the range (dropped
	// sessions list).
	LastPath string
}

// Walk computes the path of one session from its events in time order.
// Steps must be hit in order; other events in between are ignored, and a
// repeated step does not move the session forward. Every occurrence of step 1
// is tried as a start and the deepest path wins (the earliest start on ties),
// so a session that retries later inside the window is credited.
func Walk(d Definition, evs []session.Event) (Path, bool) {
	var best Path
	found := false
	for start, ev := range evs {
		if !d.Steps[0].Matches(ev) {
			continue
		}
		at := []time.Time{ev.TS}
		for _, next := range evs[start+1:] {
			if len(at) == len(d.Steps) {
				break
			}
			if d.Within > 0 && next.TS.Sub(at[0]) > d.Within {
				break
			}
			if d.Steps[len(at)].Matches(next) {
				at = append(at, next.TS)
			}
		}
		if !found || len(at) > best.Reached {
			best = Path{Reached: len(at), At: at}
			found = true
		}
		if best.Reached == len(d.Steps) {
			break
		}
	}
	if !found {
		return Path{}, false
	}
	for _, ev := range evs {
		if ev.UserID != "" {
			best.UserID = ev.UserID
		}
		if ev.Name == NavigationEvent && ev.Attrs[PathAttr] != "" {
			best.LastPath = ev.Attrs[PathAttr]
		}
	}
	if len(evs) > 0 {
		best.SessionID = evs[0].SessionID
	}
	return best, true
}

// Paths groups events by session (events without a session id are dropped),
// sorts each session's events and walks them.
func Paths(d Definition, evs []session.Event) []Path {
	by := map[string][]session.Event{}
	for _, ev := range evs {
		if ev.SessionID == "" {
			continue
		}
		by[ev.SessionID] = append(by[ev.SessionID], ev)
	}
	out := make([]Path, 0, len(by))
	for _, own := range by {
		session.SortEvents(own)
		if p, ok := Walk(d, own); ok {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SessionID < out[j].SessionID })
	return out
}

// StepResult is one row of the report.
type StepResult struct {
	Step     Step   `json:"step"`
	Label    string `json:"label"`
	Sessions int    `json:"sessions"`
	Users    int    `json:"users"`
	// ConversionFromFirst and ConversionFromPrevious are percentages (0..100).
	ConversionFromFirst    float64 `json:"conversion_from_first"`
	ConversionFromPrevious float64 `json:"conversion_from_previous"`
	// DroppedOff is the sessions that reached the previous step but not
	// this one (0 for step 1).
	DroppedOff int `json:"dropped_off"`
	// MedianMs and P75Ms are the time from the previous step, over the
	// sessions that reached this step; nil for step 1.
	MedianMs *int64 `json:"median_ms"`
	P75Ms    *int64 `json:"p75_ms"`
}

// Report aggregates paths into one row per step.
func Report(d Definition, paths []Path) []StepResult {
	rows := make([]StepResult, len(d.Steps))
	for i, s := range d.Steps {
		users := map[string]bool{}
		var gaps []int64
		n := 0
		for _, p := range paths {
			if p.Reached <= i {
				continue
			}
			n++
			if p.UserID != "" {
				users[p.UserID] = true
			}
			if i > 0 {
				gaps = append(gaps, p.At[i].Sub(p.At[i-1]).Milliseconds())
			}
		}
		rows[i] = StepResult{Step: s, Label: s.String(), Sessions: n, Users: len(users)}
		if i > 0 {
			prev := rows[i-1].Sessions
			rows[i].DroppedOff = prev - n
			rows[i].ConversionFromPrevious = pct(n, prev)
			rows[i].MedianMs, rows[i].P75Ms = quantile(gaps, 0.5), quantile(gaps, 0.75)
		}
		rows[i].ConversionFromFirst = pct(n, rows[0].Sessions)
	}
	return rows
}

// Dropped returns the paths that reached step `step-1` but not `step`
// (1-based, 2..len(steps)), latest drop first.
func Dropped(paths []Path, step int) []Path {
	var out []Path
	for _, p := range paths {
		if p.Reached == step-1 {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].At[len(out[i].At)-1], out[j].At[len(out[j].At)-1]
		if !a.Equal(b) {
			return a.After(b)
		}
		return out[i].SessionID < out[j].SessionID
	})
	return out
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
	rank := int(q*float64(len(s)) + 0.999999999)
	rank = min(max(rank, 1), len(s))
	x := s[rank-1]
	return &x
}
