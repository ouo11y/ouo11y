// Package vitals aggregates browser Web Vitals over many sessions
// (docs/specs/web-vitals.md).
package vitals

import (
	"math"
	"sort"
	"strconv"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// Loki names of the `web_vital` attributes the browser SDK sends.
const (
	AttrName         = "ouo_web_vital_name"
	AttrValue        = "ouo_web_vital_value"
	AttrID           = "ouo_web_vital_id"
	AttrTarget       = "ouo_web_vital_inp_target"
	AttrType         = "ouo_web_vital_inp_interaction_type"
	AttrInputDelay   = "ouo_web_vital_inp_input_delay_ms"
	AttrProcessing   = "ouo_web_vital_inp_processing_duration_ms"
	AttrPresentation = "ouo_web_vital_inp_presentation_delay_ms"
	AttrInvoker      = "ouo_web_vital_inp_script_invoker"
	AttrInvokerType  = "ouo_web_vital_inp_script_invoker_type"
	AttrScriptFile   = "code_file_path"
	AttrScriptFunc   = "code_function_name"
	AttrRoute        = "app_screen_name"
	AttrPath         = "url_path"
)

// INP ratings (web.dev): good below 200 ms, poor from 500 ms.
const (
	inpGood = 200
	inpPoor = 500
)

// Script is the Long Animation Frame script seen most often in a group's
// interactions.
type Script struct {
	Invoker     string `json:"invoker,omitempty"`
	InvokerType string `json:"invoker_type,omitempty"`
	File        string `json:"file,omitempty"`
	Function    string `json:"function,omitempty"`
	Count       int    `json:"count"`
}

// InteractionGroup is the INP of one element on one page.
type InteractionGroup struct {
	// Target is the element's selector (`app.widget.id`); empty when the SDK
	// sent none (the element left the DOM, or an SDK without attribution).
	Target string `json:"target"`
	// Page is the route template (`app.screen.name`) when the app sets one,
	// else the URL path.
	Page            string   `json:"page"`
	InteractionType string   `json:"interaction_type,omitempty"`
	Count           int      `json:"count"` // page views whose INP was this element
	Sessions        int      `json:"sessions"`
	P75Ms           float64  `json:"p75_ms"`
	MaxMs           float64  `json:"max_ms"`
	Rating          string   `json:"rating"`
	InputDelayMs    *float64 `json:"input_delay_p75_ms"`
	ProcessingMs    *float64 `json:"processing_duration_p75_ms"`
	PresentationMs  *float64 `json:"presentation_delay_p75_ms"`
	Script          *Script  `json:"script"`
}

type sample struct {
	ev    session.Event
	value float64
}

// INPByTarget groups INP events by target and page and sorts the groups by
// p75, slowest first. A page view reports its INP several times (each
// change, and again at page hide); only its latest, largest value counts.
// Events without a value are skipped.
func INPByTarget(events []session.Event) []InteractionGroup {
	latest := map[[2]string]sample{}
	for _, ev := range events {
		if ev.Name != "web_vital" || ev.Attrs[AttrName] != "INP" {
			continue
		}
		v, err := strconv.ParseFloat(ev.Attrs[AttrValue], 64)
		if err != nil || math.IsNaN(v) || v < 0 {
			continue
		}
		key := [2]string{ev.SessionID, ev.Attrs[AttrID]}
		if ev.Attrs[AttrID] == "" {
			key[1] = ev.TS.String() // no id: every event is its own page view
		}
		if prev, ok := latest[key]; !ok || v >= prev.value {
			latest[key] = sample{ev: ev, value: v}
		}
	}
	type acc struct {
		g                                  InteractionGroup
		values, input, processing, present []float64
		sessions                           map[string]bool
		types                              map[string]int
		scripts                            map[Script]int
	}
	groups := map[[2]string]*acc{}
	for _, s := range latest {
		page := s.ev.Attrs[AttrRoute]
		if page == "" {
			page = s.ev.Attrs[AttrPath]
		}
		key := [2]string{s.ev.Attrs[AttrTarget], page}
		a := groups[key]
		if a == nil {
			a = &acc{g: InteractionGroup{Target: key[0], Page: key[1]}, sessions: map[string]bool{}, types: map[string]int{}, scripts: map[Script]int{}}
			groups[key] = a
		}
		a.values = append(a.values, s.value)
		a.sessions[s.ev.SessionID] = true
		if t := s.ev.Attrs[AttrType]; t != "" {
			a.types[t]++
		}
		for attr, dst := range map[string]*[]float64{AttrInputDelay: &a.input, AttrProcessing: &a.processing, AttrPresentation: &a.present} {
			if f, err := strconv.ParseFloat(s.ev.Attrs[attr], 64); err == nil {
				*dst = append(*dst, f)
			}
		}
		sc := Script{Invoker: s.ev.Attrs[AttrInvoker], InvokerType: s.ev.Attrs[AttrInvokerType], File: s.ev.Attrs[AttrScriptFile], Function: s.ev.Attrs[AttrScriptFunc]}
		if sc != (Script{}) {
			a.scripts[sc]++
		}
	}
	out := make([]InteractionGroup, 0, len(groups))
	for _, a := range groups {
		g := a.g
		g.Count = len(a.values)
		g.Sessions = len(a.sessions)
		g.P75Ms = quantile(a.values, 0.75)
		g.MaxMs = slicesMax(a.values)
		g.Rating = rating(g.P75Ms)
		g.InputDelayMs, g.ProcessingMs, g.PresentationMs = optQuantile(a.input), optQuantile(a.processing), optQuantile(a.present)
		g.InteractionType = mostFrequent(a.types)
		var best *Script
		for sc, n := range a.scripts {
			if best == nil || n > best.Count || (n == best.Count && lessScript(sc, *best)) {
				c := sc
				c.Count = n
				best = &c
			}
		}
		g.Script = best
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].P75Ms != out[j].P75Ms {
			return out[i].P75Ms > out[j].P75Ms
		}
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if out[i].Target != out[j].Target {
			return out[i].Target < out[j].Target
		}
		return out[i].Page < out[j].Page
	})
	return out
}

// quantile is the nearest-rank quantile (the value at rank ceil(q*n)), the
// same rule as the funnel times.
func quantile(v []float64, q float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	i := int(math.Ceil(q*float64(len(s)))) - 1
	return s[max(0, min(i, len(s)-1))]
}

func optQuantile(v []float64) *float64 {
	if len(v) == 0 {
		return nil
	}
	q := quantile(v, 0.75)
	return &q
}

func slicesMax(v []float64) float64 {
	m := v[0]
	for _, x := range v[1:] {
		m = max(m, x)
	}
	return m
}

func rating(ms float64) string {
	switch {
	case ms <= inpGood:
		return "good"
	case ms > inpPoor:
		return "poor"
	}
	return "needs-improvement"
}

func mostFrequent(m map[string]int) string {
	best, n := "", 0
	for k, c := range m {
		if c > n || (c == n && k < best) {
			best, n = k, c
		}
	}
	return best
}

func lessScript(a, b Script) bool {
	if a.Invoker != b.Invoker {
		return a.Invoker < b.Invoker
	}
	return a.File+a.Function < b.File+b.Function
}
