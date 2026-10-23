package session

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Mobile vitals (docs/specs/mobile-vitals.md): the four event names, their
// summary per session and the display ratings of section 4.

const (
	VitalAppStart      = "ouo.app.start"
	VitalScreenDisplay = "ouo.screen.display"
	VitalJank          = "app.jank"
	VitalStall         = "ouo.stall"
)

// VitalNames are the event names of the mobile vitals spec, in spec order.
var VitalNames = []string{VitalAppStart, VitalScreenDisplay, VitalJank, VitalStall}

// IsVital reports whether an event name is one of VitalNames.
func IsVital(name string) bool {
	switch name {
	case VitalAppStart, VitalScreenDisplay, VitalJank, VitalStall:
		return true
	}
	return false
}

// Rating is the display hint of mobile vitals spec section 4.
type Rating string

const (
	RatingGood             Rating = "good"
	RatingNeedsImprovement Rating = "needs-improvement"
	RatingPoor             Rating = "poor"
)

func rate(v, good, poor float64) Rating {
	switch {
	case v < good:
		return RatingGood
	case v >= poor:
		return RatingPoor
	}
	return RatingNeedsImprovement
}

// worse returns the worse of two ratings ("" counts as unknown, not good).
func worse(a, b Rating) Rating {
	rank := map[Rating]int{"": 0, RatingGood: 1, RatingNeedsImprovement: 2, RatingPoor: 3}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

// RateAppStart rates a cold (< 2 s good, >= 5 s poor) or warm (< 1 s good,
// >= 2 s poor) start. An unknown type gives no rating.
func RateAppStart(typ string, ms float64) Rating {
	switch typ {
	case "cold":
		return rate(ms, 2000, 5000)
	case "warm":
		return rate(ms, 1000, 2000)
	}
	return ""
}

// RateTTID rates a time to initial display: < 1 s good, >= 2.5 s poor.
func RateTTID(ms float64) Rating { return rate(ms, 1000, 2500) }

// RateFrames rates one frames window: the worse of the slow-frame ratio
// (slow / total: < 5 % good, >= 25 % poor) and the frozen frames (0 good,
// >= 1 poor). No rating without frames.
func RateFrames(total, slow, frozen int) Rating {
	if total <= 0 {
		return ""
	}
	r := rate(float64(slow)/float64(total), 0.05, 0.25)
	if frozen > 0 {
		r = RatingPoor
	}
	return r
}

// RateStalls rates one stall window by its total stall time: 0 good,
// >= 1 s poor.
func RateStalls(totalMs float64) Rating {
	if totalMs <= 0 {
		return RatingGood
	}
	return rate(totalMs, 0, 1000)
}

// Vital is one entry of GET /v1/sessions/{id}/vitals.
type Vital struct {
	TS      time.Time `json:"ts"`
	Name    string    `json:"name"`
	Screen  string    `json:"screen,omitempty"`
	TraceID string    `json:"trace_id,omitempty"`
	SpanID  string    `json:"span_id,omitempty"`
	// Values holds the record's numeric attributes without their prefix
	// (ttid_ms, duration_ms, total, slow, frozen, delay_ms, count, ...) and
	// `type` (a string) for app starts.
	Values map[string]any `json:"values"`
	Rating Rating         `json:"rating,omitempty"`
}

// AppStartSummary is summary.app_start.
type AppStartSummary struct {
	Type       string  `json:"type"`
	DurationMs float64 `json:"duration_ms"`
	Rating     Rating  `json:"rating,omitempty"`
}

// TTIDSummary is summary.ttid_ms.
type TTIDSummary struct {
	P50 float64 `json:"p50"`
	Max float64 `json:"max"`
}

// FramesSummary is summary.frames: sums over the session's app.jank records.
type FramesSummary struct {
	Total     int     `json:"total"`
	Slow      int     `json:"slow"`
	Frozen    int     `json:"frozen"`
	SlowRatio float64 `json:"slow_ratio"`
}

// StallsSummary is summary.stalls: sums (count, total) and max (longest)
// over the session's ouo.stall records.
type StallsSummary struct {
	Count     int     `json:"count"`
	TotalMs   float64 `json:"total_ms"`
	LongestMs float64 `json:"longest_ms"`
}

// VitalsSummary is the summary of GET /v1/sessions/{id}/vitals; a field is
// absent when the session has no record of that kind.
type VitalsSummary struct {
	AppStart *AppStartSummary `json:"app_start,omitempty"`
	Screens  *int             `json:"screens,omitempty"`
	TTIDMs   *TTIDSummary     `json:"ttid_ms,omitempty"`
	Frames   *FramesSummary   `json:"frames,omitempty"`
	Stalls   *StallsSummary   `json:"stalls,omitempty"`
}

// vitalPrefixes are the Loki attribute prefixes stripped into Vital.Values,
// per event name.
var vitalPrefixes = map[string][]string{
	VitalAppStart:      {"ouo_app_start_"},
	VitalScreenDisplay: {"ouo_screen_"},
	VitalJank:          {"ouo_frames_", "app_jank_"},
	VitalStall:         {"ouo_stall_"},
}

// VitalOf converts a vital event (IsVital(ev.Name)) into its API form.
func VitalOf(ev Event) Vital {
	v := Vital{
		TS: ev.TS, Name: ev.Name, Screen: ev.Attrs["app_screen_name"],
		TraceID: ev.Attrs["trace_id"], SpanID: ev.Attrs["span_id"],
		Values: map[string]any{},
	}
	for k, raw := range ev.Attrs {
		for _, p := range vitalPrefixes[ev.Name] {
			key, ok := strings.CutPrefix(k, p)
			if !ok || key == "" {
				continue
			}
			if f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
				v.Values[key] = f
			} else if ev.Name == VitalAppStart && key == "type" {
				v.Values[key] = raw
			}
		}
	}
	switch ev.Name {
	case VitalAppStart:
		if ms, ok := num(ev, "ouo_app_start_duration_ms"); ok {
			v.Rating = RateAppStart(ev.Attrs["ouo_app_start_type"], ms)
		}
	case VitalScreenDisplay:
		if ms, ok := num(ev, "ouo_screen_ttid_ms"); ok {
			v.Rating = RateTTID(ms)
		}
	case VitalJank:
		total, _ := num(ev, "ouo_frames_total")
		slow, _ := num(ev, "ouo_frames_slow")
		frozen, _ := num(ev, "ouo_frames_frozen")
		v.Rating = RateFrames(int(total), int(slow), int(frozen))
	case VitalStall:
		if ms, ok := num(ev, "ouo_stall_total_ms"); ok {
			v.Rating = RateStalls(ms)
		}
	}
	return v
}

func num(ev Event, key string) (float64, bool) {
	raw, ok := ev.Attrs[key]
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// AppStart returns the session's app start (the first ouo.app.start with a
// usable duration), or false when it has none.
func AppStart(evs []Event) (AppStartSummary, bool) {
	for _, ev := range evs {
		if ev.Name != VitalAppStart {
			continue
		}
		ms, ok := num(ev, "ouo_app_start_duration_ms")
		if !ok {
			continue
		}
		typ := ev.Attrs["ouo_app_start_type"]
		return AppStartSummary{Type: typ, DurationMs: ms, Rating: RateAppStart(typ, ms)}, true
	}
	return AppStartSummary{}, false
}

// Vitals returns the session's vital records in time order (events are
// expected sorted, as FoldOne leaves them) and their summary.
func Vitals(evs []Event) ([]Vital, VitalsSummary) {
	out := []Vital{}
	var sum VitalsSummary
	if as, ok := AppStart(evs); ok {
		sum.AppStart = &as
	}
	var screens int
	var ttids []float64
	var frames FramesSummary
	var jank bool
	var stalls StallsSummary
	var stalled bool
	for _, ev := range evs {
		if !IsVital(ev.Name) {
			continue
		}
		out = append(out, VitalOf(ev))
		switch ev.Name {
		case VitalScreenDisplay:
			screens++
			if ms, ok := num(ev, "ouo_screen_ttid_ms"); ok {
				ttids = append(ttids, ms)
			}
		case VitalJank:
			jank = true
			t, _ := num(ev, "ouo_frames_total")
			s, _ := num(ev, "ouo_frames_slow")
			f, _ := num(ev, "ouo_frames_frozen")
			frames.Total += int(t)
			frames.Slow += int(s)
			frames.Frozen += int(f)
		case VitalStall:
			stalled = true
			c, _ := num(ev, "ouo_stall_count")
			tot, _ := num(ev, "ouo_stall_total_ms")
			l, _ := num(ev, "ouo_stall_longest_ms")
			stalls.Count += int(c)
			stalls.TotalMs += tot
			stalls.LongestMs = max(stalls.LongestMs, l)
		}
	}
	if screens > 0 {
		sum.Screens = &screens
	}
	if len(ttids) > 0 {
		sum.TTIDMs = &TTIDSummary{P50: median(ttids), Max: maxOf(ttids)}
	}
	if jank {
		if frames.Total > 0 {
			frames.SlowRatio = math.Round(float64(frames.Slow)/float64(frames.Total)*10000) / 10000
		}
		sum.Frames = &frames
	}
	if stalled {
		sum.Stalls = &stalls
	}
	return out, sum
}

// median is the 50th percentile: the middle value, or the mean of the two
// middle values for an even count.
func median(xs []float64) float64 {
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func maxOf(xs []float64) float64 {
	m := xs[0]
	for _, x := range xs[1:] {
		m = max(m, x)
	}
	return m
}
