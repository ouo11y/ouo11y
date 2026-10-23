package session

import (
	"encoding/json"
	"testing"
	"time"
)

func TestRatings(t *testing.T) {
	cases := []struct {
		name string
		got  Rating
		want Rating
	}{
		{"cold good", RateAppStart("cold", 1999.9), RatingGood},
		{"cold needs", RateAppStart("cold", 2000), RatingNeedsImprovement},
		{"cold needs high", RateAppStart("cold", 4999), RatingNeedsImprovement},
		{"cold poor", RateAppStart("cold", 5000), RatingPoor},
		{"warm good", RateAppStart("warm", 999), RatingGood},
		{"warm needs", RateAppStart("warm", 1000), RatingNeedsImprovement},
		{"warm poor", RateAppStart("warm", 2000), RatingPoor},
		{"unknown start type", RateAppStart("hot", 10), ""},
		{"ttid good", RateTTID(999), RatingGood},
		{"ttid needs", RateTTID(1000), RatingNeedsImprovement},
		{"ttid poor", RateTTID(2500), RatingPoor},
		{"frames good", RateFrames(100, 4, 0), RatingGood},
		{"frames needs at 5%", RateFrames(100, 5, 0), RatingNeedsImprovement},
		{"frames poor at 25%", RateFrames(100, 25, 0), RatingPoor},
		{"one frozen frame is poor", RateFrames(1000, 0, 1), RatingPoor},
		{"no frames no rating", RateFrames(0, 0, 0), ""},
		{"stalls none", RateStalls(0), RatingGood},
		{"stalls needs", RateStalls(999), RatingNeedsImprovement},
		{"stalls poor", RateStalls(1000), RatingPoor},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %q want %q", c.name, c.got, c.want)
		}
	}
}

func TestTypeOfVitals(t *testing.T) {
	for _, n := range VitalNames {
		if TypeOf(n) != TypeVital {
			t.Errorf("%s: %s", n, TypeOf(n))
		}
	}
	if TypeOf("web_vital") != TypeWebVital || TypeOf("app.jank.other") != TypeCustom {
		t.Fatal("non-vitals must keep their type")
	}
}

func TestVitalsFromLoki(t *testing.T) {
	evs := load(t, "mobile_vitals")
	vitals, sum := Vitals(evs)
	if len(vitals) != 7 {
		t.Fatalf("vitals: %d %+v", len(vitals), vitals)
	}

	// Summary, as in the spec example.
	if sum.AppStart == nil || *sum.AppStart != (AppStartSummary{Type: "cold", DurationMs: 3060.7, Rating: RatingNeedsImprovement}) {
		t.Fatalf("app_start: %+v", sum.AppStart)
	}
	if sum.Screens == nil || *sum.Screens != 3 {
		t.Fatalf("screens: %v", sum.Screens)
	}
	if sum.TTIDMs == nil || *sum.TTIDMs != (TTIDSummary{P50: 410.2, Max: 3316.2}) {
		t.Fatalf("ttid: %+v", sum.TTIDMs)
	}
	if sum.Frames == nil || *sum.Frames != (FramesSummary{Total: 1840, Slow: 31, Frozen: 1, SlowRatio: 0.0168}) {
		t.Fatalf("frames: %+v", sum.Frames)
	}
	if sum.Stalls == nil || *sum.Stalls != (StallsSummary{Count: 2, TotalMs: 340, LongestMs: 220}) {
		t.Fatalf("stalls: %+v", sum.Stalls)
	}

	// Records.
	as := vitals[0]
	if as.Name != VitalAppStart || as.Screen != "Home" || as.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || as.SpanID != "00f067aa0ba902b7" || as.Rating != RatingNeedsImprovement {
		t.Fatalf("app start: %+v", as)
	}
	if as.Values["type"] != "cold" || as.Values["duration_ms"] != 3060.7 || len(as.Values) != 2 {
		t.Fatalf("app start values: %v", as.Values)
	}
	want := time.UnixMilli(1791280800000).UTC().Add(3060700 * time.Microsecond)
	if !as.TS.Equal(want) {
		t.Fatalf("app start ts %v want %v", as.TS, want)
	}
	home := vitals[1]
	if home.Name != VitalScreenDisplay || home.Values["ttid_ms"] != 3316.2 || home.Rating != RatingPoor {
		t.Fatalf("home: %+v", home)
	}
	jank := vitals[2]
	wantJank := map[string]any{"frame_count": 5.0, "period": 2.5, "total": 120.0, "slow": 4.0, "frozen": 1.0, "delay_ms": 812.5}
	if jank.Name != VitalJank || jank.Rating != RatingPoor || len(jank.Values) != len(wantJank) {
		t.Fatalf("jank: %+v", jank)
	}
	for k, v := range wantJank {
		if jank.Values[k] != v {
			t.Errorf("jank %s: %v want %v", k, jank.Values[k], v)
		}
	}
	cart := vitals[3]
	if cart.Values["ttfd_ms"] != 900.0 || cart.Rating != RatingGood || cart.TraceID != "" {
		t.Fatalf("cart: %+v", cart)
	}
	stall := vitals[4]
	if stall.Name != VitalStall || stall.Values["count"] != 2.0 || stall.Values["longest_ms"] != 220.0 || stall.Values["period_ms"] != 3000.0 || stall.Rating != RatingNeedsImprovement {
		t.Fatalf("stall: %+v", stall)
	}
	if last := vitals[6]; last.Values["threshold"] != 0.016666666666666666 || last.Rating != RatingGood {
		t.Fatalf("last jank: %+v", last)
	}

	// Integers serialise without a fraction.
	b, _ := json.Marshal(jank.Values)
	if string(b) != `{"delay_ms":812.5,"frame_count":5,"frozen":1,"period":2.5,"slow":4,"total":120}` {
		t.Fatalf("values json: %s", b)
	}
}

func TestVitalsSummaryAbsentFields(t *testing.T) {
	vitals, sum := Vitals(nil)
	if vitals == nil || len(vitals) != 0 {
		t.Fatalf("vitals must be an empty slice: %v", vitals)
	}
	b, _ := json.Marshal(sum)
	if string(b) != `{}` {
		t.Fatalf("empty summary: %s", b)
	}
	// Only a stall: every other summary field stays absent.
	evs := []Event{{TS: base, Name: VitalStall, SessionID: "s", Attrs: map[string]string{"ouo_stall_count": "1", "ouo_stall_total_ms": "60", "ouo_stall_longest_ms": "60"}}}
	_, sum = Vitals(evs)
	b, _ = json.Marshal(sum)
	if string(b) != `{"stalls":{"count":1,"total_ms":60,"longest_ms":60}}` {
		t.Fatalf("stall-only summary: %s", b)
	}
}

func TestMedianEven(t *testing.T) {
	if m := median([]float64{400, 100, 300, 200}); m != 250 {
		t.Fatalf("median: %v", m)
	}
}

func TestFoldAppStart(t *testing.T) {
	evs := load(t, "mobile_vitals")
	rec := FoldOne("V", evs, base, DefaultOptions)
	if rec.AppStartMs == nil || *rec.AppStartMs != 3060.7 || rec.AppStartType != "cold" {
		t.Fatalf("app start: %v %q", rec.AppStartMs, rec.AppStartType)
	}
	if rec.Status != StatusHealthy {
		t.Fatalf("vitals must not change the status: %s", rec.Status)
	}
	// No app start: both fields are omitted from the JSON.
	rec = FoldOne("C", load(t, "mobile_crash_end"), base, DefaultOptions)
	b, _ := json.Marshal(rec)
	var raw map[string]any
	json.Unmarshal(b, &raw)
	if _, ok := raw["app_start_ms"]; ok {
		t.Fatalf("app_start_ms present without an app start: %s", b)
	}
	if _, ok := raw["app_start_type"]; ok {
		t.Fatalf("app_start_type present without an app start: %s", b)
	}
}
