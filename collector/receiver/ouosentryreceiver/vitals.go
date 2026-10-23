package ouosentryreceiver

import (
	"math"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
)

// Mobile vitals from transaction measurements (docs/specs/mobile-vitals.md,
// section 6).
const (
	eventAppStart      = "ouo.app.start"
	eventScreenDisplay = "ouo.screen.display"
	eventJank          = "app.jank"
	eventStall         = "ouo.stall"

	// maxVitalMs drops values that can only come from a clock jump (spec
	// section 3, rule 2).
	maxVitalMs = float64(time.Hour / time.Millisecond)
)

// measurementMs returns a measurement in milliseconds, converted from its
// unit; ok is false when it is absent, of an unknown unit or out of range.
func measurementMs(e *sentryEvent, name string) (float64, bool) {
	m, ok := e.Measurements[name]
	if !ok {
		return 0, false
	}
	v := m.Value
	switch m.Unit {
	case "millisecond", "":
	case "second":
		v *= 1000
	case "microsecond":
		v /= 1e3
	case "nanosecond":
		v /= 1e6
	default:
		return 0, false
	}
	if v < 0 || v > maxVitalMs || math.IsNaN(v) {
		return 0, false
	}
	return v, true
}

// measurementCount returns a count measurement (unit `none`).
func measurementCount(e *sentryEvent, name string) (int64, bool) {
	m, ok := e.Measurements[name]
	if !ok || (m.Unit != "none" && m.Unit != "") || m.Value < 0 || math.IsNaN(m.Value) {
		return 0, false
	}
	return int64(math.Round(m.Value)), true
}

// emitVitals turns a transaction's measurements into vital records with the
// root span's trace and span id. screen is the transaction's screen for
// screen loads, else the session's current screen.
func (t *translation) emitVitals(e *sentryEvent, x *sess, match, userID string, tid pcommon.TraceID, sid pcommon.SpanID, screen string) {
	if len(e.Measurements) == 0 {
		return
	}
	op := ""
	if e.Contexts.Trace != nil {
		op = e.Contexts.Trace.Op
	}
	start, end := e.StartTimestamp.Time, e.Timestamp.Time
	window := ""
	switch op {
	case "ui.load", "navigation":
		window = "screen"
	case "ui.action":
		window = "interaction"
	}
	newVital := func(name string, ts time.Time) pcommon.Map {
		lr := t.newRecord(name, ts, x, match, userID, plog.SeverityNumberInfo)
		lr.SetTraceID(tid)
		lr.SetSpanID(sid)
		a := lr.Attributes()
		a.PutStr("ouo.vital.source", "sentry")
		if screen != "" {
			a.PutStr("app.screen.name", screen)
		}
		return a
	}
	periodMs := float64(end.Sub(start)) / float64(time.Millisecond)

	// App start: the transaction starts at process start (observed), so the
	// first frame is at start + duration. One per session.
	for _, k := range []struct{ name, typ string }{{"app_start_cold", "cold"}, {"app_start_warm", "warm"}} {
		v, ok := measurementMs(e, k.name)
		if !ok || (x != nil && x.appStartEmitted) {
			continue
		}
		a := newVital(eventAppStart, start.Add(msDuration(v)))
		a.PutStr("ouo.app.start.type", k.typ)
		a.PutDouble("ouo.app.start.duration_ms", v)
		if x != nil {
			x.appStartEmitted = true
		}
		break
	}

	if v, ok := measurementMs(e, "time_to_initial_display"); ok && window == "screen" {
		a := newVital(eventScreenDisplay, start.Add(msDuration(v)))
		a.PutDouble("ouo.screen.ttid_ms", v)
		if f, ok := measurementMs(e, "time_to_full_display"); ok {
			a.PutDouble("ouo.screen.ttfd_ms", f)
		}
	}

	if total, ok := measurementCount(e, "frames_total"); ok && total > 0 {
		slow, _ := measurementCount(e, "frames_slow")
		frozen, _ := measurementCount(e, "frames_frozen")
		a := newVital(eventJank, end)
		a.PutInt("app.jank.frame_count", slow+frozen)
		a.PutDouble("app.jank.period", periodMs/1000)
		a.PutInt("ouo.frames.total", total)
		a.PutInt("ouo.frames.slow", slow)
		a.PutInt("ouo.frames.frozen", frozen)
		if d, ok := measurementMs(e, "frames_delay"); ok {
			a.PutDouble("ouo.frames.delay_ms", d)
		}
		if window != "" {
			a.PutStr("ouo.vital.window", window)
		}
	}

	if n, ok := measurementCount(e, "stall_count"); ok && n > 0 {
		total, _ := measurementMs(e, "stall_total_time")
		longest, _ := measurementMs(e, "stall_longest_time")
		a := newVital(eventStall, end)
		a.PutInt("ouo.stall.count", n)
		a.PutDouble("ouo.stall.total_ms", total)
		a.PutDouble("ouo.stall.longest_ms", longest)
		a.PutDouble("ouo.stall.period_ms", periodMs)
		if window != "" {
			a.PutStr("ouo.vital.window", window)
		}
	}
}

func msDuration(ms float64) time.Duration { return time.Duration(ms * float64(time.Millisecond)) }
