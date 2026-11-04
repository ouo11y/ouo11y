package funnel

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

func attrEvt(sid string, sec int, name string, attrs ...string) session.Event {
	ev := evt(sid, sec, name)
	for i := 0; i+1 < len(attrs); i += 2 {
		ev.Attrs[attrs[i]] = attrs[i+1]
	}
	return ev
}

func TestConditionValidate(t *testing.T) {
	good := []Condition{
		{Key: "payment.method", Value: "card"},
		{Key: "payment_method", Op: OpNeq, Value: ""},
		{Key: "http.response.status-code", Op: OpRegex, Value: "5.."},
		{Key: "_private", Value: "x y"},
		{Key: "os.name", Value: "iOS"}, // a context key rum-api keeps
		{Key: "user.id", Value: "u-1"}, // an identifier key
		{Key: "note", Value: strings.Repeat("é", MaxValueLen/2)},
	}
	for _, c := range good {
		if err := c.Validate(); err != nil {
			t.Errorf("%+v: %v", c, err)
		}
	}
	bad := []Condition{
		{Key: "", Value: "x"},
		{Key: "1abc", Value: "x"},
		{Key: `payment.method"="x" or session_id=~".+`, Value: "x"},
		{Key: "a b", Value: "x"},
		{Key: "a}", Value: "x"},
		{Key: "a|b", Value: "x"},
		{Key: strings.Repeat("k", MaxKeyLen+1), Value: "x"},
		{Key: "event.name", Value: "x"},
		{Key: "telemetry.sdk.name", Value: "x"}, // noise key rum-api drops
		{Key: "k", Value: "line\nbreak"},
		{Key: "k", Value: "nul\x00"},
		{Key: "k", Value: "\xff\xfe"},
		{Key: "k", Value: strings.Repeat("v", MaxValueLen+1)},
		{Key: "k", Op: OpRegex, Value: ""},
		{Key: "k", Op: OpRegex, Value: "(unclosed"},
		{Key: "k", Op: "!~", Value: "x"},
		{Key: "k", Op: ">", Value: "1"},
	}
	for _, c := range bad {
		if err := c.Validate(); err == nil {
			t.Errorf("%+v accepted", c)
		}
	}
	c := Condition{Key: "k"}
	if c.Validate() != nil || c.Op != OpEq {
		t.Errorf("default op %q", c.Op)
	}
}

// TestConditionLogQLInjection: whatever the value, the label filter is the
// key, the operator and exactly one Go-quoted literal that unquotes back to
// the value, so a value cannot close the string and add LogQL.
func TestConditionLogQLInjection(t *testing.T) {
	for _, v := range []string{
		`card`,
		`card"} |= "x`,
		`card" or session_id=~".+`,
		`\" or 1=1`,
		`back\slash`,
		"`backtick`",
		`{event_name="navigation"}`,
		`ünï"cødé`,
		`a|b.*`,
	} {
		for _, op := range []Op{OpEq, OpNeq, OpRegex} {
			c := Condition{Key: "payment.method", Op: op, Value: v}
			if op == OpRegex {
				c.Value = regexpQuote(v)
			}
			if err := c.Validate(); err != nil {
				t.Fatalf("%q: %v", c.Value, err)
			}
			got := c.LogQL()
			prefix := "payment_method" + string(op)
			if !strings.HasPrefix(got, prefix) {
				t.Fatalf("%s: prefix", got)
			}
			lit := got[len(prefix):]
			q, err := strconv.QuotedPrefix(lit)
			if err != nil || q != lit {
				t.Fatalf("%s: not one literal (%q, %v)", got, q, err)
			}
			if u, _ := strconv.Unquote(lit); u != c.Value {
				t.Fatalf("%s: unquotes to %q", got, u)
			}
		}
	}
}

func regexpQuote(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(`\.+*?()|[]{}^$`, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func TestConditionMatches(t *testing.T) {
	ev := attrEvt("a", 0, "checkout.submit", "payment_method", "card", "amount", "120")
	ev.Context = map[string]string{"os_name": "iOS"}
	ev.Platform = "mobile"
	for _, tc := range []struct {
		c    Condition
		want bool
	}{
		{Condition{Key: "payment.method", Value: "card"}, true},
		{Condition{Key: "payment.method", Value: "paypal"}, false},
		{Condition{Key: "payment.method", Op: OpNeq, Value: "paypal"}, true},
		{Condition{Key: "missing", Value: ""}, true}, // LogQL: a missing key is ""
		{Condition{Key: "missing", Op: OpNeq, Value: ""}, false},
		{Condition{Key: "amount", Op: OpRegex, Value: "1[0-9]+"}, true},
		{Condition{Key: "amount", Op: OpRegex, Value: "2"}, false}, // anchored
		{Condition{Key: "os.name", Value: "iOS"}, true},
		{Condition{Key: "ouo.platform", Value: "mobile"}, true},
	} {
		if err := tc.c.Validate(); err != nil {
			t.Fatal(err)
		}
		if got := tc.c.Matches(ev); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.c, got, tc.want)
		}
	}
}

func TestParseStepConditions(t *testing.T) {
	for _, in := range []string{
		"event:checkout.submit where payment.method=card",
		`event:checkout.submit where payment.method=card and note="two words" and plan=~"pro|team" and coupon!=""`,
		`event:pay where reason="a \"quoted\" and odd value"`,
	} {
		st, err := ParseStep(in)
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if st.String() != in {
			t.Errorf("round trip %s -> %s", in, st.String())
		}
	}
	st, err := ParseStep(`event:checkout.submit where payment.method = card  and  amount!=0`)
	if err != nil || len(st.Where) != 2 || st.Where[0].Key != "payment.method" || st.Where[0].Value != "card" || st.Where[1].Op != OpNeq || st.Where[1].Value != "0" {
		t.Fatalf("loose spacing: %+v %v", st, err)
	}
	if st.Value != "checkout.submit" {
		t.Errorf("name %q", st.Value)
	}
	for _, bad := range []string{
		"page:/checkout where a=b",
		"event:x where ",
		"event:x where a",
		"event:x where =b",
		"event:x where a=b or c=d",
		`event:x where a="unterminated`,
		`event:x where a="v" b=c`,
		"event:x where a=1 and b=2 and c=3 and d=4 and e=5 and f=6",
		`event:x where k"=v`,
	} {
		if _, err := ParseStep(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func checkout() Definition {
	return Definition{Steps: []Step{
		{Kind: KindEvent, Value: "cart.view"},
		{Kind: KindEvent, Value: "checkout.submit", Where: []Condition{{Key: "payment.method", Value: "card"}}},
		{Kind: KindEvent, Value: "payment.success"},
	}, Failure: &Step{Kind: KindEvent, Value: "exception"}}
}

func TestWalkConditions(t *testing.T) {
	d := checkout()
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	card := []session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card"), evt("a", 9, "payment.success")}
	paypal := []session.Event{evt("b", 0, "cart.view"), attrEvt("b", 5, "checkout.submit", "payment_method", "paypal"), evt("b", 9, "payment.success")}
	// A paypal attempt, then a card one: the card one moves the session on.
	both := []session.Event{evt("c", 0, "cart.view"), attrEvt("c", 3, "checkout.submit", "payment_method", "paypal"), attrEvt("c", 6, "checkout.submit", "payment_method", "card"), evt("c", 9, "payment.success")}
	for _, tc := range []struct {
		name string
		evs  []session.Event
		want int
	}{{"card", card, 3}, {"paypal", paypal, 1}, {"paypal then card", both, 3}} {
		if p, _ := Walk(d, tc.evs); p.Reached != tc.want {
			t.Errorf("%s: reached %d, want %d", tc.name, p.Reached, tc.want)
		}
	}
}

func TestWalkFailure(t *testing.T) {
	cases := []struct {
		name    string
		within  time.Duration
		failure *Step
		evs     []session.Event
		reached int
		failed  bool
		msg     string
	}{
		{"exception after the attempt", 0, nil, []session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card"), attrEvt("a", 6, "exception")}, 2, true, "exception"},
		{"exception at the same instant as the step", 0, nil, []session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card"), attrEvt("a", 5, "exception")}, 2, true, "exception"},
		{"exception before the step only", 0, nil, []session.Event{evt("a", 0, "cart.view"), attrEvt("a", 1, "exception"), attrEvt("a", 5, "checkout.submit", "payment_method", "card")}, 2, false, ""},
		{"no exception: abandoned", 0, nil, []session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card")}, 2, false, ""},
		{"exception then converts", 0, nil, []session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card"), evt("a", 6, "exception"), evt("a", 9, "payment.success")}, 3, false, ""},
		{"exception outside the window", 10 * time.Second, nil, []session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card"), evt("a", 11, "exception")}, 2, false, ""},
		{"exception inside the window", 10 * time.Second, nil, []session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card"), evt("a", 10, "exception")}, 2, true, "exception"},
		{"failure at step 1", 0, nil, []session.Event{evt("a", 0, "cart.view"), evt("a", 2, "exception")}, 1, true, "exception"},
		{"named failure event with a condition", 0, &Step{Kind: KindEvent, Value: "payment.failed", Where: []Condition{{Key: "reason", Value: "declined"}}},
			[]session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card"), attrEvt("a", 6, "payment.failed", "reason", "timeout"), attrEvt("a", 7, "payment.failed", "reason", "declined"), evt("a", 8, "exception")}, 2, true, "payment.failed"},
		{"failure event that is the step event itself", 0, &Step{Kind: KindEvent, Value: "checkout.submit"},
			[]session.Event{evt("a", 0, "cart.view"), attrEvt("a", 5, "checkout.submit", "payment_method", "card")}, 2, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := checkout()
			d.Within = tc.within
			if tc.failure != nil {
				d.Failure = tc.failure
			}
			if err := d.Validate(); err != nil {
				t.Fatal(err)
			}
			p, ok := Walk(d, tc.evs)
			if !ok || p.Reached != tc.reached || p.Failed != tc.failed || p.FailureEvent != tc.msg {
				t.Fatalf("got %+v", p)
			}
			if tc.failed && p.FailedAt.Before(p.At[p.Reached-1]) {
				t.Errorf("failed at %s before the last step %s", p.FailedAt, p.At[p.Reached-1])
			}
		})
	}
	// Failure tracking off.
	d := checkout()
	d.Failure = nil
	if p, _ := Walk(d, cases[0].evs); p.Failed {
		t.Errorf("failed with tracking off")
	}
}

func TestReportFailedAndOutcome(t *testing.T) {
	d := checkout()
	var evs []session.Event
	// a converts; b fails at checkout (exception after submit); c abandons
	// at checkout; e fails before checkout; f abandons before checkout.
	evs = append(evs, evt("a", 0, "cart.view"), attrEvt("a", 1, "checkout.submit", "payment_method", "card"), evt("a", 2, "payment.success"))
	evs = append(evs, evt("b", 0, "cart.view"), attrEvt("b", 1, "checkout.submit", "payment_method", "card"), session.Event{TS: t0.Add(3 * time.Second), Name: "exception", SessionID: "b", Line: "TypeError: card declined " + strings.Repeat("x", 400), Attrs: map[string]string{}})
	evs = append(evs, evt("c", 0, "cart.view"), attrEvt("c", 1, "checkout.submit", "payment_method", "card"))
	evs = append(evs, evt("e", 0, "cart.view"), evt("e", 4, "exception"))
	evs = append(evs, evt("f", 0, "cart.view"), attrEvt("f", 1, "checkout.submit", "payment_method", "paypal"))
	paths := Paths(d, evs)
	rows := Report(d, paths)
	want := []struct {
		sessions, dropped, failed int
		rate                      float64
	}{{5, 0, 0, 0}, {3, 2, 1, 20}, {1, 2, 1, 33.33}}
	for i, w := range want {
		r := rows[i]
		if r.Sessions != w.sessions || r.DroppedOff != w.dropped || r.Failed != w.failed || r.FailureRate != w.rate {
			t.Errorf("step %d: %+v, want %+v", i+1, r, w)
		}
	}
	if got := Dropped(paths, 3, OutcomeFailed); len(got) != 1 || got[0].SessionID != "b" {
		t.Fatalf("failed at 3: %+v", got)
	} else if m := got[0].FailureMessage; !strings.HasPrefix(m, "TypeError: card declined") || len([]rune(m)) != maxFailureMessage || !strings.HasSuffix(m, "…") {
		t.Errorf("message %q", m)
	}
	if got := Dropped(paths, 3, OutcomeAbandoned); len(got) != 1 || got[0].SessionID != "c" {
		t.Errorf("abandoned at 3: %+v", got)
	}
	if got := Dropped(paths, 3, OutcomeAny); len(got) != 2 {
		t.Errorf("all at 3: %+v", got)
	}
	if got := Dropped(paths, 2, OutcomeFailed); len(got) != 1 || got[0].SessionID != "e" {
		t.Errorf("failed at 2: %+v", got)
	}
	if _, err := ParseOutcome("crashed"); err == nil {
		t.Error("bad outcome accepted")
	}
}

func TestDefinitionValidateFailure(t *testing.T) {
	d := checkout()
	d.Failure = &Step{Value: "payment.failed"}
	if err := d.Validate(); err != nil || d.Failure.Kind != KindEvent {
		t.Fatalf("default kind: %v %+v", err, d.Failure)
	}
	for _, f := range []*Step{
		{Kind: KindPage, Value: "/error"},
		{Kind: KindEvent, Value: "navigation"},
		{Kind: KindEvent, Value: ""},
		{Kind: KindEvent, Value: "x", Where: []Condition{{Key: "bad key", Value: "v"}}},
	} {
		d.Failure = f
		if d.Validate() == nil {
			t.Errorf("failure %+v accepted", f)
		}
	}
	d = checkout()
	d.Steps[0].Value = "bad\nname"
	if d.Validate() == nil {
		t.Error("control character in a step name accepted")
	}
}
