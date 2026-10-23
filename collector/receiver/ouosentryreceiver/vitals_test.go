package ouosentryreceiver

import (
	"math"
	"testing"
	"time"
)

// A4: mobile vitals from transaction measurements (docs/specs/mobile-vitals.md, section 6).

func vitalTx(name, op, spanID string, start, end float64, m map[string]any) string {
	return item("transaction", map[string]any{"type": "transaction", "transaction": name, "start_timestamp": start, "timestamp": end,
		"user":         map[string]any{"id": device},
		"contexts":     map[string]any{"trace": map[string]any{"trace_id": trace1, "span_id": spanID, "op": op}},
		"measurements": m})
}

func ms(v float64) map[string]any   { return map[string]any{"value": v, "unit": "millisecond"} }
func none(v float64) map[string]any { return map[string]any{"value": v, "unit": "none"} }

func TestVitalsFromMeasurements(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00.000Z")))
	const t0 = 1791972000.0 // the session start
	x.send(t, `{"event_id":"a"}`, vitalTx("Home", "ui.load", "1000000000000001", t0-2, t0+1.3, map[string]any{
		"app_start_cold": ms(3000), "time_to_initial_display": ms(3300), "time_to_full_display": ms(3500),
		"stall_count": none(0), "stall_total_time": ms(0), "stall_longest_time": ms(0)}))
	// A second app start in the same session is not a new launch.
	x.send(t, `{"event_id":"b"}`, vitalTx("Home", "ui.load", "1000000000000002", t0+5, t0+6, map[string]any{"app_start_warm": ms(900)}))
	x.send(t, `{"event_id":"c"}`, vitalTx("Product", "navigation", "1000000000000003", t0+10, t0+10.7, map[string]any{
		"time_to_initial_display": ms(700), "frames_total": none(40), "frames_slow": none(3), "frames_frozen": none(1),
		"frames_delay": map[string]any{"value": 0.25, "unit": "second"}}))
	x.send(t, `{"event_id":"d"}`, vitalTx("browse catalog", "ui.action", "1000000000000004", t0+20, t0+22, map[string]any{
		"frames_total": none(0), "frames_slow": none(0), "frames_frozen": none(0),
		"stall_count": none(2), "stall_total_time": ms(340), "stall_longest_time": ms(220),
		"time_to_initial_display": ms(10)})) // TTID outside a screen load is ignored
	x.send(t, `{"event_id":"e"}`, vitalTx("Cart", "navigation", "1000000000000005", t0+30, t0+31, map[string]any{
		"time_to_initial_display": map[string]any{"value": 5, "unit": "parsec"}, "frames_total": none(-1)}))

	at := func(r rec, sec float64) {
		t.Helper()
		want := time.Unix(0, int64(math.Round(sec*1e9)))
		if d := r.ts.Sub(want); d < -time.Millisecond || d > time.Millisecond {
			t.Errorf("%s at %s, want %s", r.name, r.ts.Format(time.TimeOnly+".000"), want.Format(time.TimeOnly+".000"))
		}
	}
	starts := x.byName(eventAppStart)
	if len(starts) != 1 {
		t.Fatalf("app starts: %+v", starts)
	}
	a := starts[0].attrs
	if a["ouo.app.start.type"] != "cold" || a["ouo.app.start.duration_ms"] != 3000.0 || a["app.screen.name"] != "Home" || a["session.id"] != sid1 || a["ouo.vital.source"] != "sentry" {
		t.Errorf("app start: %+v", a)
	}
	at(starts[0], t0+1) // first frame: transaction start (process start) + 3 s

	disp := x.byName(eventScreenDisplay)
	if len(disp) != 2 {
		t.Fatalf("screen displays: %+v", disp)
	}
	if d := disp[0].attrs; d["app.screen.name"] != "Home" || d["ouo.screen.ttid_ms"] != 3300.0 || d["ouo.screen.ttfd_ms"] != 3500.0 {
		t.Errorf("Home display: %+v", d)
	}
	at(disp[0], t0+1.3)
	if d := disp[1].attrs; d["app.screen.name"] != "Product" || d["ouo.screen.ttid_ms"] != 700.0 || d["ouo.screen.ttfd_ms"] != nil {
		t.Errorf("Product display: %+v", d)
	}

	jank := x.byName(eventJank)
	if len(jank) != 1 {
		t.Fatalf("app.jank: %+v", jank)
	}
	j := jank[0].attrs
	if j["app.jank.frame_count"] != int64(4) || j["ouo.frames.total"] != int64(40) || j["ouo.frames.slow"] != int64(3) || j["ouo.frames.frozen"] != int64(1) ||
		j["ouo.frames.delay_ms"] != 250.0 || j["ouo.vital.window"] != "screen" || j["app.screen.name"] != "Product" || j["app.jank.threshold"] != nil {
		t.Errorf("app.jank: %+v", j)
	}
	if p, _ := j["app.jank.period"].(float64); math.Abs(p-0.7) > 1e-6 {
		t.Errorf("app.jank.period %v, want 0.7 s", j["app.jank.period"])
	}
	at(jank[0], t0+10.7)

	stalls := x.byName(eventStall)
	if len(stalls) != 1 {
		t.Fatalf("stalls: %+v", stalls)
	}
	s := stalls[0].attrs
	if s["ouo.stall.count"] != int64(2) || s["ouo.stall.total_ms"] != 340.0 || s["ouo.stall.longest_ms"] != 220.0 || s["ouo.stall.period_ms"] != 2000.0 ||
		s["ouo.vital.window"] != "interaction" || s["app.screen.name"] != "Product" {
		t.Errorf("stall: %+v", s)
	}
	at(stalls[0], t0+22)

	// Every vital record carries the transaction's trace and root span.
	for _, name := range []string{eventAppStart, eventScreenDisplay, eventJank, eventStall} {
		for _, r := range x.byName(name) {
			if r.trace != trace1 || r.span == "" {
				t.Errorf("%s: trace %q span %q", name, r.trace, r.span)
			}
		}
	}
}

// The selfhosted capture (@sentry/react-native 8.30.0, real taps): one cold
// start, one warm start after the background relaunch, a TTID per screen load.
func TestGoldenVitals(t *testing.T) {
	x := newTx(t)
	replayGolden(t, x, loadGolden(t, "testdata/golden/ios-rn-8.30.0/selfhosted"))
	g := summarize(t, x)
	checkInvariants(t, x, g)
	types := map[string]int{}
	for _, r := range x.byName(eventAppStart) {
		types[r.attrs["ouo.app.start.type"].(string)]++
		if d, _ := r.attrs["ouo.app.start.duration_ms"].(float64); d < 100 || d > 60000 {
			t.Errorf("app start duration %v", d)
		}
	}
	if types["cold"] != 1 || types["warm"] < 1 {
		t.Errorf("app starts by type: %v", types)
	}
	disp := x.byName(eventScreenDisplay)
	if len(disp) < 3 {
		t.Errorf("screen displays: %d", len(disp))
	}
	for _, r := range disp {
		if r.attrs["app.screen.name"] == nil || r.attrs["ouo.screen.ttid_ms"] == nil {
			t.Errorf("screen display: %+v", r.attrs)
		}
	}
	if len(x.byName(eventJank)) == 0 {
		t.Error("no app.jank records")
	}
}
