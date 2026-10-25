package funnel

import (
	"os"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

var t0 = time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

func nav(sid string, sec int, path string) session.Event {
	return session.Event{TS: t0.Add(time.Duration(sec) * time.Second), Name: NavigationEvent, SessionID: sid, UserID: "u-" + sid,
		Attrs: map[string]string{PathAttr: path}}
}

func evt(sid string, sec int, name string) session.Event {
	return session.Event{TS: t0.Add(time.Duration(sec) * time.Second), Name: name, SessionID: sid, UserID: "u-" + sid, Attrs: map[string]string{}}
}

func shop() Definition {
	return Definition{Steps: []Step{
		{Kind: KindPage, Value: "/"},
		{Kind: KindPage, Match: MatchPrefix, Value: "/products/"},
		{Kind: KindEvent, Value: "add_to_cart"},
		{Kind: KindEvent, Value: "order_paid"},
	}}
}

func TestWalkStrictOrder(t *testing.T) {
	d := shop()
	cases := []struct {
		name string
		evs  []session.Event
		want int
	}{
		{"full", []session.Event{nav("a", 0, "/"), nav("a", 5, "/products/1"), evt("a", 9, "add_to_cart"), evt("a", 20, "order_paid")}, 4},
		{"out of order: cart before product", []session.Event{nav("a", 0, "/"), evt("a", 2, "add_to_cart"), nav("a", 5, "/products/1"), evt("a", 20, "order_paid")}, 2},
		{"never step 1", []session.Event{nav("a", 5, "/products/1"), evt("a", 9, "add_to_cart")}, 0},
		{"repeated steps count once", []session.Event{nav("a", 0, "/"), nav("a", 1, "/"), nav("a", 2, "/products/1"), nav("a", 3, "/products/2"), evt("a", 4, "add_to_cart"), evt("a", 5, "add_to_cart")}, 3},
		{"prefix does not match exact /", []session.Event{nav("a", 0, "/products"), nav("a", 1, "/")}, 1},
		{"events in between ignored", []session.Event{nav("a", 0, "/"), evt("a", 1, "exception"), nav("a", 2, "/about"), nav("a", 3, "/products/9")}, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, ok := Walk(d, c.evs)
			if c.want == 0 {
				if ok {
					t.Fatalf("got path %+v, want none", p)
				}
				return
			}
			if !ok || p.Reached != c.want {
				t.Fatalf("reached %d (ok %v), want %d", p.Reached, ok, c.want)
			}
		})
	}
}

func TestWalkWithinPicksLaterStart(t *testing.T) {
	d := shop()
	d.Within = 30 * time.Second
	// First visit of / stalls; a second visit 10 min later converts fast.
	evs := []session.Event{nav("a", 0, "/"), nav("a", 600, "/"), nav("a", 605, "/products/1"), evt("a", 610, "add_to_cart"), evt("a", 620, "order_paid")}
	p, ok := Walk(d, evs)
	if !ok || p.Reached != 4 || !p.At[0].Equal(t0.Add(600*time.Second)) {
		t.Fatalf("got %+v", p)
	}
	// Outside the window from the only start.
	evs = []session.Event{nav("a", 0, "/"), nav("a", 10, "/products/1"), evt("a", 31, "add_to_cart")}
	if p, _ := Walk(d, evs); p.Reached != 2 {
		t.Fatalf("reached %d, want 2", p.Reached)
	}
	// Without the window the same session reaches 3.
	d.Within = 0
	if p, _ := Walk(d, evs); p.Reached != 3 {
		t.Fatalf("reached %d, want 3", p.Reached)
	}
}

func TestReportAndDropped(t *testing.T) {
	d := shop()
	var evs []session.Event
	evs = append(evs, nav("a", 0, "/"), nav("a", 10, "/products/1"), evt("a", 20, "add_to_cart"), evt("a", 60, "order_paid"))
	evs = append(evs, nav("b", 0, "/"), nav("b", 20, "/products/2"), evt("b", 40, "add_to_cart"))
	evs = append(evs, nav("c", 0, "/"), nav("c", 30, "/products/3"))
	evs = append(evs, nav("d", 0, "/"), nav("d", 1, "/about"))
	evs = append(evs, nav("e", 0, "/cart"))                                                                  // never enters
	evs = append(evs, session.Event{TS: t0, Name: NavigationEvent, Attrs: map[string]string{PathAttr: "/"}}) // no session id
	// Same user as a, second session.
	f := nav("f", 0, "/")
	f.UserID = "u-a"
	evs = append(evs, f)

	paths := Paths(d, evs)
	rows := Report(d, paths)
	want := []struct {
		sessions, users, dropped int
		fromFirst, fromPrev      float64
	}{
		{5, 4, 0, 100, 0},
		{3, 3, 2, 60, 60},
		{2, 2, 1, 40, 66.67},
		{1, 1, 1, 20, 50},
	}
	for i, w := range want {
		r := rows[i]
		if r.Sessions != w.sessions || r.Users != w.users || r.DroppedOff != w.dropped || r.ConversionFromFirst != w.fromFirst || r.ConversionFromPrevious != w.fromPrev {
			t.Errorf("step %d: got %+v, want %+v", i+1, r, w)
		}
	}
	if rows[0].MedianMs != nil {
		t.Errorf("step 1 has a median")
	}
	// Step 2 gaps: 10s, 20s, 30s -> median 20s, p75 30s.
	if *rows[1].MedianMs != 20000 || *rows[1].P75Ms != 30000 {
		t.Errorf("step 2 times %d / %d", *rows[1].MedianMs, *rows[1].P75Ms)
	}
	if rows[1].Label != "page:/products/*" {
		t.Errorf("label %q", rows[1].Label)
	}

	dropped := Dropped(paths, 2)
	if len(dropped) != 2 || dropped[0].SessionID != "d" || dropped[1].SessionID != "f" {
		t.Fatalf("dropped at 2: %+v", dropped)
	}
	if dropped[0].LastPath != "/about" {
		t.Errorf("last path %q", dropped[0].LastPath)
	}
	if got := Dropped(paths, 4); len(got) != 1 || got[0].SessionID != "b" {
		t.Errorf("dropped at 4: %+v", got)
	}
}

func TestEmptyReport(t *testing.T) {
	rows := Report(shop(), nil)
	for _, r := range rows {
		if r.Sessions != 0 || r.ConversionFromFirst != 0 || r.MedianMs != nil {
			t.Fatalf("got %+v", r)
		}
	}
}

// TestLokiFixture walks a real-shaped Loki response: the navigation and
// custom-event queries of one funnel, two sessions, one of which started
// before the range (its step 1 is not in the fixture: the caller queried
// [from, to] only, so it never enters).
func TestLokiFixture(t *testing.T) {
	var evs []session.Event
	for _, f := range []string{"testdata/navigation.json", "testdata/events.json"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		e, err := session.ParseLokiResponse(b)
		if err != nil {
			t.Fatal(err)
		}
		evs = append(evs, e...)
	}
	paths := Paths(shop(), evs)
	if len(paths) != 2 {
		t.Fatalf("paths %+v", paths)
	}
	rows := Report(shop(), paths)
	if rows[0].Sessions != 2 || rows[1].Sessions != 2 || rows[2].Sessions != 1 || rows[3].Sessions != 0 {
		t.Fatalf("rows %+v", rows)
	}
	if paths[0].UserID == "" {
		t.Errorf("user id not lifted")
	}
}

func TestParseStep(t *testing.T) {
	for in, want := range map[string]Step{
		"page:/":            {Kind: KindPage, Match: MatchExact, Value: "/"},
		"page:/products/*":  {Kind: KindPage, Match: MatchPrefix, Value: "/products/"},
		"event:add_to_cart": {Kind: KindEvent, Value: "add_to_cart"},
		"event:a:b":         {Kind: KindEvent, Value: "a:b"},
	} {
		got, err := ParseStep(in)
		if err != nil || got != want {
			t.Errorf("%s: got %+v, %v", in, got, err)
		}
		if got.String() != in {
			t.Errorf("round trip %s -> %s", in, got.String())
		}
	}
	for _, bad := range []string{"", "page", "page:", "page:cart", "click:#buy", "event:navigation"} {
		if _, err := ParseStep(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestDefinitionValidate(t *testing.T) {
	d := Definition{Steps: []Step{{Kind: KindPage, Value: "/"}}}
	if d.Validate() == nil {
		t.Error("1 step accepted")
	}
	d = shop()
	d.Within = MaxWithin + time.Second
	if d.Validate() == nil {
		t.Error("within over max accepted")
	}
	d.Within = time.Hour
	if err := d.Validate(); err != nil {
		t.Error(err)
	}
}
