package vitals

import (
	"strconv"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

var t0 = time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)

// inp is one INP web_vital event of a page view (session sid, metric id id).
func inp(sid, id string, sec int, value float64, attrs map[string]string) session.Event {
	a := map[string]string{AttrName: "INP", AttrID: id, AttrValue: strconv.FormatFloat(value, 'f', -1, 64)}
	for k, v := range attrs {
		a[k] = v
	}
	return session.Event{TS: t0.Add(time.Duration(sec) * time.Second), Name: "web_vital", SessionID: sid, Attrs: a}
}

func TestINPByTargetGroupsDedupesAndSorts(t *testing.T) {
	save := func(path string, input, proc, pres string) map[string]string {
		return map[string]string{AttrTarget: "button#save", AttrPath: path, AttrType: "pointer", AttrInputDelay: input, AttrProcessing: proc, AttrPresentation: pres,
			AttrInvoker: "BUTTON#save.onclick", AttrInvokerType: "event-listener", AttrScriptFile: "https://shop.example/app.js", AttrScriptFunc: "save"}
	}
	events := []session.Event{
		// Page view s1/v1 reports twice (a change, then page hide): only 480 counts.
		inp("s1", "v1", 1, 120, save("/patients/1", "4", "100", "16")),
		inp("s1", "v1", 9, 480, save("/patients/1", "8", "440", "32")),
		inp("s2", "v1", 2, 300, save("/patients/2", "6", "270", "24")),
		inp("s3", "v1", 3, 620, save("/patients/3", "10", "580", "30")),
		inp("s3", "v2", 4, 200, save("/patients/3", "2", "180", "18")),
		// The route template groups the three paths when the app sets one.
		inp("s4", "v1", 5, 90, map[string]string{AttrTarget: "a#home", AttrPath: "/", AttrType: "pointer"}),
		inp("s5", "v1", 6, 56, map[string]string{AttrTarget: "input#q", AttrPath: "/search", AttrRoute: "/search", AttrType: "keyboard"}),
		// No target (an SDK without attribution, or the element left the DOM).
		inp("s6", "v1", 7, 700, map[string]string{AttrPath: "/"}),
		// Not INP, or no value: skipped.
		{TS: t0, Name: "web_vital", SessionID: "s7", Attrs: map[string]string{AttrName: "LCP", AttrValue: "2500", AttrPath: "/"}},
		{TS: t0, Name: "web_vital", SessionID: "s7", Attrs: map[string]string{AttrName: "INP", AttrValue: "", AttrPath: "/"}},
	}
	for i := range events[:5] {
		events[i].Attrs[AttrRoute] = "/patients/:id"
	}
	got := INPByTarget(events)
	if len(got) != 4 {
		t.Fatalf("groups %+v", got)
	}
	if got[0].Target != "" || got[0].P75Ms != 700 || got[0].Rating != "poor" || got[0].Script != nil || got[0].ProcessingMs != nil {
		t.Errorf("unattributed group %+v", got[0])
	}
	g := got[1]
	// Page views 480, 300, 620, 200: nearest-rank p75 is the 3rd of 4 sorted = 480.
	if g.Target != "button#save" || g.Page != "/patients/:id" || g.Count != 4 || g.Sessions != 3 || g.P75Ms != 480 || g.MaxMs != 620 || g.Rating != "needs-improvement" {
		t.Errorf("save group %+v", g)
	}
	if g.InteractionType != "pointer" || *g.InputDelayMs != 8 || *g.ProcessingMs != 440 || *g.PresentationMs != 30 {
		t.Errorf("phases %+v %v %v %v", g.InteractionType, *g.InputDelayMs, *g.ProcessingMs, *g.PresentationMs)
	}
	if g.Script == nil || g.Script.Invoker != "BUTTON#save.onclick" || g.Script.Function != "save" || g.Script.Count != 4 {
		t.Errorf("script %+v", g.Script)
	}
	if got[2].Target != "a#home" || got[2].Page != "/" || got[2].Rating != "good" {
		t.Errorf("home group %+v", got[2])
	}
	if got[3].Target != "input#q" || got[3].InteractionType != "keyboard" {
		t.Errorf("search group %+v", got[3])
	}
}

func TestINPByTargetScriptIsTheMostFrequent(t *testing.T) {
	ev := func(sid, invoker string) session.Event {
		return inp(sid, "v1", 0, 300, map[string]string{AttrTarget: "button#pay", AttrPath: "/pay", AttrInvoker: invoker})
	}
	got := INPByTarget([]session.Event{ev("a", "BUTTON#pay.onclick"), ev("b", "Window.setTimeout"), ev("c", "BUTTON#pay.onclick"), ev("d", "")})
	if len(got) != 1 || got[0].Script == nil || got[0].Script.Invoker != "BUTTON#pay.onclick" || got[0].Script.Count != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestQuantileAndRating(t *testing.T) {
	if q := quantile([]float64{40}, 0.75); q != 40 {
		t.Errorf("one value: %v", q)
	}
	if q := quantile([]float64{10, 20, 30, 40, 50, 60, 70, 80}, 0.75); q != 60 {
		t.Errorf("eight values: %v", q)
	}
	for ms, want := range map[float64]string{200: "good", 200.1: "needs-improvement", 500: "needs-improvement", 501: "poor"} {
		if got := rating(ms); got != want {
			t.Errorf("rating(%v) = %s, want %s", ms, got, want)
		}
	}
}
