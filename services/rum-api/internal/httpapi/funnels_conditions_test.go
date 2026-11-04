package httpapi

import (
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/funnel"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// Step conditions, the failed outcome and truncation (ADR-0019).

func fattr(ev session.Event, kv ...string) session.Event {
	for i := 0; i+1 < len(kv); i += 2 {
		ev.Attrs[kv[i]] = kv[i+1]
	}
	return ev
}

// payEvents: a payment journey. 1 pays by card; 2 submits by card and hits
// an exception; 3 submits by card and leaves; 4 submits by paypal (not the
// conditioned step) and pays; 5 views the cart only and hits an exception.
func payEvents() []session.Event {
	exc := fev("2", 8, "exception", "")
	exc.Line = "PaymentError: card declined"
	return []session.Event{
		fev("1", 0, "cart.view", ""), fattr(fev("1", 1, "checkout.submit", ""), "payment_method", "card"), fev("1", 2, "payment.success", ""),
		fev("2", 5, "cart.view", ""), fattr(fev("2", 6, "checkout.submit", ""), "payment_method", "card"), exc,
		fev("3", 10, "cart.view", ""), fattr(fev("3", 11, "checkout.submit", ""), "payment_method", "card"),
		fev("4", 15, "cart.view", ""), fattr(fev("4", 16, "checkout.submit", ""), "payment_method", "paypal"), fev("4", 17, "payment.success", ""),
		fev("5", 20, "cart.view", ""), fev("5", 21, "exception", ""),
	}
}

const payBody = `{"steps":[{"kind":"event","value":"cart.view"},
	{"kind":"event","value":"checkout.submit","where":[{"key":"payment.method","value":"card"}]},
	{"kind":"event","value":"payment.success"}],"from":"now-1h","to":"now"}`

const paySteps = "event:cart.view,event:checkout.submit where payment.method=card,event:payment.success"

func TestFunnelConditionsAndFailed(t *testing.T) {
	ts, fe, _ := newFunnelServer(t, "")
	fe.events = payEvents()
	resp, fr := postFunnel(t, ts, payBody)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	got := []int{fr.Steps[0].Sessions, fr.Steps[1].Sessions, fr.Steps[2].Sessions}
	if !equalInts(got, []int{5, 3, 1}) {
		t.Fatalf("sessions %v", got)
	}
	// Step 2: 4 (paypal) and 5 dropped, 5 after an exception. Step 3: 2
	// failed, 3 abandoned.
	if s := fr.Steps[1]; s.DroppedOff != 2 || s.Failed != 1 || s.FailureRate != 20 {
		t.Errorf("step 2 %+v", s)
	}
	if s := fr.Steps[2]; s.DroppedOff != 2 || s.Failed != 1 || s.FailureRate != 33.33 {
		t.Errorf("step 3 %+v", s)
	}
	if fr.Failed != 2 || fr.Steps[1].Label != "event:checkout.submit where payment.method=card" {
		t.Errorf("failed %d label %q", fr.Failed, fr.Steps[1].Label)
	}
	var ev string
	for _, q := range fe.queries {
		if strings.Contains(q, "checkout") {
			ev = q
		}
	}
	if !strings.HasSuffix(ev, `{service_name=~".+", event_name=~"cart\\.view|checkout\\.submit|payment\\.success"} | (event_name="cart.view") or (event_name="checkout.submit" and ((payment_method="card"))) or (event_name="payment.success")`) {
		t.Errorf("events query %s", ev)
	}

	// The failed sessions of step 3, then the abandoned ones.
	var dr droppedResponse
	base := ts.URL + "/v1/funnels/dropped?from=now-1h&steps=" + url.QueryEscape(paySteps)
	if code := getFunnelJSON(t, base+"&step=3&outcome=failed", &dr); code != 200 {
		t.Fatalf("status %d", code)
	}
	if dr.Total != 1 || dr.Outcome != funnel.OutcomeFailed {
		t.Fatalf("failed %+v", dr)
	}
	s := dr.Sessions[0]
	if s.SessionID != "2" || s.Outcome != funnel.OutcomeFailed || s.FailureEvent != "exception" || s.FailureMessage != "PaymentError: card declined" || s.FailedAt == nil {
		t.Errorf("failed session %+v", s)
	}
	dr = droppedResponse{}
	getFunnelJSON(t, base+"&step=3&outcome=abandoned", &dr)
	if dr.Total != 1 || dr.Sessions[0].SessionID != "3" || dr.Sessions[0].Outcome != funnel.OutcomeAbandoned || dr.Sessions[0].FailedAt != nil {
		t.Errorf("abandoned %+v", dr)
	}
	getFunnelJSON(t, base+"&step=3", &dr)
	if dr.Total != 2 {
		t.Errorf("all %+v", dr)
	}
	if code := getFunnelJSON(t, base+"&step=3&outcome=crashed", &dr); code != 400 {
		t.Errorf("bad outcome: %d", code)
	}
}

func TestFunnelFailureEvent(t *testing.T) {
	ts, fe, _ := newFunnelServer(t, "")
	fe.events = append(payEvents(), fattr(fev("3", 12, "payment.failed", ""), "reason", "declined"))
	// Off: no failure read, nothing failed.
	body := strings.Replace(payBody, `"from"`, `"failure":{"off":true},"from"`, 1)
	_, fr := postFunnel(t, ts, body)
	if fr.Failed != 0 || fr.Failure != nil || len(fe.queries) != 1 {
		t.Fatalf("off: failed %d failure %+v queries %v", fr.Failed, fr.Failure, fe.queries)
	}
	// A named failure event with a condition: only 3 fails.
	fe.queries = nil
	body = strings.Replace(payBody, `"from"`, `"failure":{"event":"payment.failed","where":[{"key":"reason","value":"declined"}]},"from"`, 1)
	_, fr = postFunnel(t, ts, body)
	if fr.Failed != 1 || fr.Steps[2].Failed != 1 || fr.Failure == nil || fr.Failure.Value != "payment.failed" {
		t.Fatalf("named: %+v", fr)
	}
	if !strings.Contains(strings.Join(fe.queries, "\n"), `event_name="payment.failed"} | reason="declined"`) {
		t.Errorf("failure query: %v", fe.queries)
	}
	// The same through the URL form.
	var dr droppedResponse
	u := ts.URL + "/v1/funnels/dropped?from=now-1h&step=3&outcome=failed&steps=" + url.QueryEscape(paySteps) +
		"&failure=" + url.QueryEscape("event:payment.failed where reason=declined")
	if code := getFunnelJSON(t, u, &dr); code != 200 || dr.Total != 1 || dr.Sessions[0].SessionID != "3" {
		t.Fatalf("url failure: %d %+v", code, dr)
	}
	for _, bad := range []string{"page:/error", "event:", "event:x where k", "event:navigation"} {
		if code := getFunnelJSON(t, ts.URL+"/v1/funnels/dropped?step=2&steps="+url.QueryEscape(paySteps)+"&failure="+url.QueryEscape(bad), &dr); code != 400 {
			t.Errorf("failure %q: %d", bad, code)
		}
	}
	if code := getFunnelJSON(t, ts.URL+"/v1/funnels/dropped?step=2&steps="+url.QueryEscape(paySteps)+"&failure=off", &dr); code != 200 {
		t.Errorf("failure=off: %d", code)
	}
}

func TestFunnelTruncated(t *testing.T) {
	ts, fe, _ := newFunnelServer(t, "")
	fe.capAt = 3
	resp, fr := postFunnel(t, ts, shopBody)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	// 10 navigation events in range are cut at 3; the 3 add_to_cart /
	// order_paid events are not.
	if !fr.Truncated || strings.Join(fr.TruncatedReads, ",") != "pages" || fr.CompleteUntil == nil {
		t.Fatalf("truncated %v %v %v", fr.Truncated, fr.TruncatedReads, fr.CompleteUntil)
	}
	// The pages read stops at its 3rd event: session 2's / at minute 5.
	if want := fnow.Add(-55 * time.Minute); !fr.CompleteUntil.Equal(want) {
		t.Errorf("complete until %s, want %s", fr.CompleteUntil, want)
	}
	if fr.Steps[0].Sessions >= 4 {
		t.Errorf("a truncated read still counted every session: %+v", fr.Steps)
	}
	var dr droppedResponse
	getFunnelJSON(t, ts.URL+"/v1/funnels/dropped?step=2&from=now-1h&steps="+url.QueryEscape("page:/,page:/products/*,event:add_to_cart,event:order_paid")+
		"&service=tiny-shop-web&environment=local&release=1.0.0&project=demo", &dr)
	if !dr.Truncated {
		t.Errorf("dropped list not marked truncated")
	}
	// Under the cap: not truncated, an empty list (not null).
	ts2, fe2, _ := newFunnelServer(t, "")
	fe2.capAt = 1000
	_, fr = postFunnel(t, ts2, shopBody)
	if fr.Truncated || fr.TruncatedReads == nil || len(fr.TruncatedReads) != 0 || fr.CompleteUntil != nil {
		t.Errorf("not truncated: %+v", fr.truncation)
	}
}

// TestFunnelInjection: hostile keys are refused; hostile values and event
// names end up inside one quoted LogQL literal.
func TestFunnelInjection(t *testing.T) {
	ts, fe, _ := newFunnelServer(t, "")
	for _, key := range []string{`payment.method\"=\"x\" or session_id=~\".+`, `a} | line_format \"x\"`, `a b`, `1a`, `event.name`, `telemetry.sdk.name`} {
		body := strings.Replace(payBody, `"key":"payment.method"`, `"key":"`+key+`"`, 1)
		if resp, _ := postFunnel(t, ts, body); resp.StatusCode != 400 {
			t.Errorf("key %s: status %d", key, resp.StatusCode)
		}
	}
	for _, v := range []string{`card\nx`, `card\u0000`} {
		body := strings.Replace(payBody, `"value":"card"`, `"value":"`+v+`"`, 1)
		if resp, _ := postFunnel(t, ts, body); resp.StatusCode != 400 {
			t.Errorf("value %s: status %d", v, resp.StatusCode)
		}
	}
	fe.queries = nil
	hostile := `card"} |= "x" or session_id=~".+`
	body := strings.Replace(payBody, `"value":"card"`, `"value":`+strconv.Quote(hostile), 1)
	body = strings.Replace(body, `"value":"cart.view"`, `"value":"cart.view\"} or {x=~\".+"`, 1)
	if resp, _ := postFunnel(t, ts, body); resp.StatusCode != 200 {
		t.Fatalf("hostile value: status %d", resp.StatusCode)
	}
	all := strings.Join(fe.queries, "\n")
	if !strings.Contains(all, `payment_method="card\"} |= \"x\" or session_id=~\".+"`) {
		t.Errorf("value not quoted: %s", all)
	}
	if !strings.Contains(all, `event_name=~"cart\\.view\"\\} or \\{x=~\"\\.\\+|`) || !strings.Contains(all, `(event_name="cart.view\"} or {x=~\".+")`) {
		t.Errorf("name not quoted: %s", all)
	}
	// Every query is one selector: no unescaped quote closes a literal early.
	for _, q := range fe.queries {
		if n := strings.Count(unescapedQuotes(q), `"`); n%2 != 0 {
			t.Errorf("odd quotes in %s", q)
		}
		if strings.Count(stripLiterals(q), "{") != 1 {
			t.Errorf("more than one selector outside literals: %s", q)
		}
	}
}

// unescapedQuotes drops backslash escapes, leaving the quotes that delimit
// literals.
func unescapedQuotes(q string) string {
	var b strings.Builder
	for i := 0; i < len(q); i++ {
		if q[i] == '\\' {
			i++
			continue
		}
		b.WriteByte(q[i])
	}
	return b.String()
}

// stripLiterals removes every "…" literal.
func stripLiterals(q string) string {
	var b strings.Builder
	for i := 0; i < len(q); i++ {
		if q[i] == '"' {
			lit, err := strconv.QuotedPrefix(q[i:])
			if err != nil {
				return q
			}
			i += len(lit) - 1
			continue
		}
		b.WriteByte(q[i])
	}
	return b.String()
}

func TestEventsFilter(t *testing.T) {
	card := []funnel.Condition{{Key: "payment.method", Value: "card"}}
	pp := []funnel.Condition{{Key: "payment.method", Value: "paypal"}, {Key: "amount", Op: funnel.OpNeq, Value: "0"}}
	for _, tc := range []struct {
		steps []funnel.Step
		want  string
	}{
		{[]funnel.Step{{Kind: funnel.KindEvent, Value: "a"}, {Kind: funnel.KindEvent, Value: "b"}}, ``},
		{[]funnel.Step{{Kind: funnel.KindPage, Value: "/"}, {Kind: funnel.KindEvent, Value: "pay", Where: card}}, ` | (payment_method="card")`},
		{[]funnel.Step{{Kind: funnel.KindEvent, Value: "pay", Where: card}, {Kind: funnel.KindEvent, Value: "pay", Where: pp}},
			` | (payment_method="card") or (payment_method="paypal" and amount!="0")`},
		// An unconditioned step of the same name needs every event of it.
		{[]funnel.Step{{Kind: funnel.KindEvent, Value: "pay", Where: card}, {Kind: funnel.KindEvent, Value: "pay"}, {Kind: funnel.KindEvent, Value: "done"}}, ``},
		{[]funnel.Step{{Kind: funnel.KindEvent, Value: "pay", Where: card}, {Kind: funnel.KindEvent, Value: "done"}},
			` | (event_name="pay" and ((payment_method="card"))) or (event_name="done")`},
	} {
		d := funnel.Definition{Steps: tc.steps}
		if err := d.Validate(); err != nil {
			t.Fatal(err)
		}
		var ev string
		for _, rd := range funnelQueries(d, FunnelFilters{}) {
			if rd.kind == "events" {
				ev = rd.query
			}
		}
		_, filter, _ := strings.Cut(ev, "}")
		if filter != tc.want {
			t.Errorf("%v: filter %q, want %q", tc.steps, filter, tc.want)
		}
	}
}
