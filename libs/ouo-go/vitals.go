package ouogo

import (
	"context"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Mobile vitals of one session (docs/specs/mobile-vitals.md): the records and their
// summary, rated per section 4. Ported from rum-api's internal/session/vitals.go and
// GET /v1/sessions/{id}/vitals.

// Vital event names, in spec order.
const (
	VitalAppStart      = "ouo.app.start"
	VitalScreenDisplay = "ouo.screen.display"
	VitalJank          = "app.jank"
	VitalStall         = "ouo.stall"
)

func isVital(name string) bool {
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

// rateAppStart rates a cold (< 2 s good, >= 5 s poor) or warm (< 1 s good, >= 2 s poor)
// start. An unknown type gives no rating.
func rateAppStart(typ string, ms float64) Rating {
	switch typ {
	case "cold":
		return rate(ms, 2000, 5000)
	case "warm":
		return rate(ms, 1000, 2000)
	}
	return ""
}

// rateTTID rates a time to initial display: < 1 s good, >= 2.5 s poor.
func rateTTID(ms float64) Rating { return rate(ms, 1000, 2500) }

// rateFrames rates one frames window: the worse of the slow-frame ratio (< 5 % good,
// >= 25 % poor) and the frozen frames (0 good, >= 1 poor). No rating without frames.
func rateFrames(total, slow, frozen int) Rating {
	if total <= 0 {
		return ""
	}
	r := rate(float64(slow)/float64(total), 0.05, 0.25)
	if frozen > 0 {
		r = RatingPoor
	}
	return r
}

// rateStalls rates one stall window by its total stall time: 0 good, >= 1 s poor.
func rateStalls(totalMs float64) Rating {
	if totalMs <= 0 {
		return RatingGood
	}
	return rate(totalMs, 0, 1000)
}

// Vital is one vital record.
type Vital struct {
	TS      time.Time `json:"ts"`
	Name    string    `json:"name"`
	Screen  string    `json:"screen,omitempty"`
	TraceID string    `json:"trace_id,omitempty"`
	SpanID  string    `json:"span_id,omitempty"`
	// Values holds the record's numeric attributes without their prefix (ttid_ms,
	// duration_ms, total, slow, frozen, delay_ms, count, ...) and `type` (a string) for
	// app starts.
	Values map[string]any `json:"values"`
	Rating Rating         `json:"rating,omitempty"`
}

// AppStartSummary is the session's first app start with a usable duration.
type AppStartSummary struct {
	Type       string  `json:"type"`
	DurationMs float64 `json:"duration_ms"`
	Rating     Rating  `json:"rating,omitempty"`
}

// TTIDSummary is the median and maximum time to initial display.
type TTIDSummary struct {
	P50 float64 `json:"p50"`
	Max float64 `json:"max"`
}

// FramesSummary sums the session's app.jank records.
type FramesSummary struct {
	Total     int     `json:"total"`
	Slow      int     `json:"slow"`
	Frozen    int     `json:"frozen"`
	SlowRatio float64 `json:"slow_ratio"` // 4 decimals
}

// StallsSummary sums count and total and takes the longest over the ouo.stall records.
type StallsSummary struct {
	Count     int     `json:"count"`
	TotalMs   float64 `json:"total_ms"`
	LongestMs float64 `json:"longest_ms"`
}

// VitalsSummary is a session's vitals summary; a field is absent when the session has no
// record of that kind.
type VitalsSummary struct {
	AppStart *AppStartSummary `json:"app_start,omitempty"`
	Screens  *int             `json:"screens,omitempty"`
	TTIDMs   *TTIDSummary     `json:"ttid_ms,omitempty"`
	Frames   *FramesSummary   `json:"frames,omitempty"`
	Stalls   *StallsSummary   `json:"stalls,omitempty"`
}

// SessionVitals is the answer of Loki.SessionVitals.
type SessionVitals struct {
	SessionID string        `json:"session_id"`
	Summary   VitalsSummary `json:"summary"`
	Vitals    []Vital       `json:"vitals"`
	// Truncated: the session has more vital records in the range than EventLimit.
	Truncated bool `json:"truncated"`
}

// vitalPrefixes are the Loki attribute prefixes stripped into Vital.Values, per name.
var vitalPrefixes = map[string][]string{
	VitalAppStart:      {"ouo_app_start_"},
	VitalScreenDisplay: {"ouo_screen_"},
	VitalJank:          {"ouo_frames_", "app_jank_"},
	VitalStall:         {"ouo_stall_"},
}

func num(labels map[string]string, key string) (float64, bool) {
	raw, ok := labels[key]
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

func vitalOf(l LokiLine) Vital {
	a := l.Labels
	name := a["event_name"]
	v := Vital{TS: l.Time.UTC(), Name: name, Screen: a["app_screen_name"], TraceID: a["trace_id"], SpanID: a["span_id"], Values: map[string]any{}}
	for k, raw := range a {
		for _, p := range vitalPrefixes[name] {
			key, ok := strings.CutPrefix(k, p)
			if !ok || key == "" {
				continue
			}
			if f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
				v.Values[key] = f
			} else if name == VitalAppStart && key == "type" {
				v.Values[key] = raw
			}
		}
	}
	switch name {
	case VitalAppStart:
		if ms, ok := num(a, "ouo_app_start_duration_ms"); ok {
			v.Rating = rateAppStart(a["ouo_app_start_type"], ms)
		}
	case VitalScreenDisplay:
		if ms, ok := num(a, "ouo_screen_ttid_ms"); ok {
			v.Rating = rateTTID(ms)
		}
	case VitalJank:
		total, _ := num(a, "ouo_frames_total")
		slow, _ := num(a, "ouo_frames_slow")
		frozen, _ := num(a, "ouo_frames_frozen")
		v.Rating = rateFrames(int(total), int(slow), int(frozen))
	case VitalStall:
		if ms, ok := num(a, "ouo_stall_total_ms"); ok {
			v.Rating = rateStalls(ms)
		}
	}
	return v
}

// vitalsOf returns the vital records of sorted lines and their summary.
func vitalsOf(lines []LokiLine) ([]Vital, VitalsSummary) {
	out := []Vital{}
	var sum VitalsSummary
	var screens int
	var ttids []float64
	var frames FramesSummary
	var jank, stalled bool
	var stalls StallsSummary
	for _, l := range lines {
		a := l.Labels
		name := a["event_name"]
		if !isVital(name) {
			continue
		}
		out = append(out, vitalOf(l))
		switch name {
		case VitalAppStart:
			if ms, ok := num(a, "ouo_app_start_duration_ms"); ok && sum.AppStart == nil {
				typ := a["ouo_app_start_type"]
				sum.AppStart = &AppStartSummary{Type: typ, DurationMs: ms, Rating: rateAppStart(typ, ms)}
			}
		case VitalScreenDisplay:
			screens++
			if ms, ok := num(a, "ouo_screen_ttid_ms"); ok {
				ttids = append(ttids, ms)
			}
		case VitalJank:
			jank = true
			t, _ := num(a, "ouo_frames_total")
			s, _ := num(a, "ouo_frames_slow")
			f, _ := num(a, "ouo_frames_frozen")
			frames.Total += int(t)
			frames.Slow += int(s)
			frames.Frozen += int(f)
		case VitalStall:
			stalled = true
			c, _ := num(a, "ouo_stall_count")
			tot, _ := num(a, "ouo_stall_total_ms")
			lg, _ := num(a, "ouo_stall_longest_ms")
			stalls.Count += int(c)
			stalls.TotalMs += tot
			stalls.LongestMs = max(stalls.LongestMs, lg)
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

// median is the middle value, or the mean of the two middle values for an even count.
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

// SessionVitals returns one session's mobile vital records, oldest first, and their
// summary. A session without vitals and a session Loki has no record of both answer an
// empty list: SessionEvents tells them apart.
func (l *Loki) SessionVitals(ctx context.Context, project, session string, r TimeRange) (*SessionVitals, error) {
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
	logql := `{ouo_project_id="` + project + `", event_name=~"ouo[.]app[.]start|ouo[.]screen[.]display|app[.]jank|ouo[.]stall"} | session_id="` + session + `"`
	lines, err := l.QueryRange(ctx, logql, from, to, limit, false)
	if err != nil {
		return nil, err
	}
	sortLines(lines)
	vitals, sum := vitalsOf(lines)
	return &SessionVitals{SessionID: session, Summary: sum, Vitals: vitals, Truncated: len(lines) >= limit}, nil
}
