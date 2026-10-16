package ouosentryreceiver

import (
	"context"
	"fmt"
	"testing"
)

const trace2 = "99990000aaaabbbbccccddddeeeeffff"

func sentryLogEntry(ts float64, level, body, traceID string, attrs map[string]any) map[string]any {
	a := map[string]any{
		"sentry.release":            map[string]any{"value": "com.acme.store@2.3.0+45", "type": "string"},
		"sentry.sdk.name":           map[string]any{"value": "sentry.javascript.react-native", "type": "string"},
		"sentry.timestamp.sequence": map[string]any{"value": 0, "type": "integer"},
		"device.model":              map[string]any{"value": "iPhone18,1", "type": "string"},
		"os.name":                   map[string]any{"value": "iOS", "type": "string"},
	}
	for k, v := range attrs {
		a[k] = v
	}
	sev := map[string]int{"debug": 5, "info": 9, "warn": 13, "error": 17}[level]
	return map[string]any{"timestamp": ts, "level": level, "body": body, "trace_id": traceID, "severity_number": sev, "attributes": a}
}

func logItem(entries ...map[string]any) string {
	return item("log", map[string]any{"version": 2, "items": entries})
}

func transactionItem(traceID string, start float64) map[string]any {
	return map[string]any{"event_id": "t1", "type": "transaction", "transaction": "checkout", "start_timestamp": start, "timestamp": start + 0.5,
		"contexts": map[string]any{"trace": map[string]any{"trace_id": traceID, "span_id": "aaaaaaaaaaaaaaaa", "op": "ui.action"}}, "spans": []any{}}
}

// 2026-10-14T10:00:00Z, the start of session() in translate_test.go.
const t0 = 1791972000.0

func TestLogsResolvedByTrace(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	// The transaction travels with a session update: its trace id is learned (rule 4).
	x.send(t, hdr("sentry.cocoa"), item("transaction", transactionItem(trace1, t0+9)), item("session", session(sid1, false, "ok", 0, "2026-10-14T10:00:09Z")))

	x.send(t, `{"sdk":{"name":"sentry.javascript.react-native","version":"8.30.0"}}`, logItem(
		sentryLogEntry(t0+10, "info", "cart loaded with 3 items", trace1, map[string]any{
			"cart.items":                  map[string]any{"value": 3, "type": "integer"},
			"cart.total":                  map[string]any{"value": 59.97, "type": "double"},
			"cart.express":                map[string]any{"value": true, "type": "boolean"},
			"sentry.message.template":     map[string]any{"value": "cart loaded with %s items", "type": "string"},
			"sentry.trace.parent_span_id": map[string]any{"value": "bbbbbbbbbbbbbbbb", "type": "string"},
			"user.email":                  map[string]any{"value": "someone@example.com", "type": "string"},
		}),
		sentryLogEntry(t0+11, "warn", "payment slow", trace2, nil),
	))
	logs := x.byName("log")
	if len(logs) != 1 {
		t.Fatalf("logs emitted before the second trace is known: %d", len(logs))
	}
	l := logs[0]
	a := l.attrs
	if a["session.id"] != sid1 || a["ouo.sentry.session_match"] != "trace" || l.body != "cart loaded with 3 items" || a["message"] != l.body ||
		a["cart.items"] != int64(3) || a["cart.total"] != 59.97 || a["cart.express"] != true ||
		a["ouo.sentry.log.template"] != "cart loaded with %s items" || l.trace != trace1 {
		t.Errorf("log: %+v trace %s", a, l.trace)
	}
	for _, k := range []string{"sentry.release", "sentry.sdk.name", "sentry.timestamp.sequence", "device.model", "os.name", "user.email", "sentry.trace.parent_span_id"} {
		if _, ok := a[k]; ok {
			t.Errorf("attribute %s copied", k)
		}
	}

	// The error carrying trace2 arrives with the session: the held log follows it.
	x.send(t, hdr("sentry.cocoa"),
		item("event", map[string]any{"event_id": "e1", "level": "error", "message": "payment failed", "timestamp": t0 + 12,
			"contexts": map[string]any{"trace": map[string]any{"trace_id": trace2, "span_id": "cccccccccccccccc"}}}),
		item("session", session(sid1, false, "ok", 1, "2026-10-14T10:00:12Z")))
	logs = x.byName("log")
	if len(logs) != 2 || logs[1].attrs["session.id"] != sid1 || logs[1].attrs["ouo.sentry.session_match"] != "trace" || logs[1].attrs["ouo.sentry.level"] != "warn" {
		t.Fatalf("held log: %+v", logs)
	}
	// The resource is the log envelope's, not the error's.
	ld := x.logs.AllLogs()
	last := ld[len(ld)-1].ResourceLogs().At(0).Resource().Attributes().AsRaw()
	if last["service.name"] != "mobile-store-ios" || last["ouo.platform"] != "mobile" {
		t.Errorf("held log resource: %+v", last)
	}
}

func TestLogsResolvedByDeviceAndExpired(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	x.send(t, `{"sdk":{"name":"sentry.javascript.react-native","version":"8.30.0"}}`, logItem(
		sentryLogEntry(t0+5, "debug", "with user", "", map[string]any{"user.id": map[string]any{"value": device, "type": "string"}}),
		sentryLogEntry(t0+6, "error", "nobody knows me", trace2, nil),
	))
	logs := x.byName("log")
	if len(logs) != 1 || logs[0].attrs["session.id"] != sid1 || logs[0].attrs["ouo.sentry.session_match"] != "device" || logs[0].attrs["user.id"] != device {
		t.Fatalf("device log: %+v", logs)
	}
	// Shutdown (or the hold time) emits the unresolved log without a session.
	x.r.flushPendingLogs(context.Background(), true)
	logs = x.byName("log")
	if len(logs) != 2 || logs[1].attrs["session.id"] != nil || logs[1].attrs["ouo.sentry.session_match"] != "none" {
		t.Fatalf("expired log: %+v", logs)
	}
	if len(x.r.pendingLogs.entries) != 0 {
		t.Errorf("pending logs left: %d", len(x.r.pendingLogs.entries))
	}
}

// A trace id seen in two sessions resolves by time, not by the first session.
func TestTraceSpanningSessions(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	x.send(t, hdr("sentry.cocoa"), item("transaction", transactionItem(trace1, t0+5)), item("session", session(sid1, false, "exited", 0, "2026-10-14T10:00:10Z")))
	s2 := session(sid2, true, "ok", 0, "2026-10-14T10:05:00Z")
	s2["started"] = "2026-10-14T10:05:00Z"
	x.send(t, hdr("sentry.cocoa"), item("session", s2))
	tr := transactionItem(trace1, t0+305)
	x.send(t, hdr("sentry.cocoa"), item("transaction", tr), item("session", s2))
	x.send(t, `{}`, logItem(sentryLogEntry(t0+6, "info", "first", trace1, nil), sentryLogEntry(t0+306, "info", "second", trace1, nil)))
	logs := x.byName("log")
	if len(logs) != 2 || logs[0].attrs["session.id"] != sid1 || logs[1].attrs["session.id"] != sid2 {
		t.Errorf("logs: %+v", logs)
	}
}

func TestBreadcrumbsAndMasking(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	start := int64(t0 * 1000)
	crumbs := fmt.Sprintf(`,{"type":5,"timestamp":%d,"data":{"tag":"options","payload":{"maskAllText":false,"maskAllImages":false,"quality":"medium"}}}`, start) +
		fmt.Sprintf(`,{"type":5,"timestamp":%d,"data":{"tag":"breadcrumb","payload":{"category":"fetch","level":"info","data":{"method":"GET","url":"http://api/products","status_code":200,"__span":"a858547d0aaac5f5"}}}}`, start+100) +
		fmt.Sprintf(`,{"type":5,"timestamp":%d,"data":{"tag":"breadcrumb","payload":{"category":"fetch","level":"error","data":{"method":"GET","url":"http://api/products?fail=500","status_code":500}}}}`, start+200) +
		fmt.Sprintf(`,{"type":5,"timestamp":%d,"data":{"tag":"breadcrumb","payload":{"category":"console","level":"debug","message":"[demo] 6 products"}}}`, start+300) +
		fmt.Sprintf(`,{"type":5,"timestamp":%d,"data":{"tag":"breadcrumb","payload":{"category":"app.background","level":"none"}}}`, start+400) +
		fmt.Sprintf(`,{"type":5,"timestamp":%d,"data":{"tag":"breadcrumb","payload":{"category":"navigation","message":"RNSScreen"}}}`, start+500) +
		fmt.Sprintf(`,{"type":5,"timestamp":%d,"data":{"tag":"breadcrumb","payload":{"category":"demo","message":"promo opened","level":"info","data":{"promo":"AUTUMN","__internal":"x"}}}}`, start+600)
	x.send(t, hdr("sentry.cocoa"), replayItemWith(replay, 0, start, device, crumbs))
	x.send(t, hdr("sentry.cocoa"), replayItemWith(replay, 1, start+5000, device, ""))

	cs := x.chunks(t)
	if len(cs) != 2 || cs[0].Masked || cs[1].Masked {
		t.Fatalf("chunks masked: %+v", cs)
	}
	reqs := x.byName("http.request")
	if len(reqs) != 1 || reqs[0].attrs["url.full"] != "http://api/products" || reqs[0].attrs["http.response.status_code"] != int64(200) || reqs[0].attrs["session.id"] != sid1 || reqs[0].ts.UnixMilli() != start+100 {
		t.Errorf("http.request: %+v", reqs)
	}
	if c := x.byName("console"); len(c) != 1 || c[0].attrs["message"] != "[demo] 6 products" {
		t.Errorf("console: %+v", c)
	}
	if a := x.byName("app.lifecycle"); len(a) != 1 || a[0].attrs["ouo.app.state"] != "background" {
		t.Errorf("app.lifecycle: %+v", a)
	}
	b := x.byName("breadcrumb")
	if len(b) != 1 || b[0].attrs["ouo.breadcrumb.category"] != "demo" || b[0].attrs["ouo.breadcrumb.data.promo"] != "AUTUMN" || b[0].attrs["ouo.breadcrumb.data.__internal"] != nil {
		t.Errorf("breadcrumb: %+v", b)
	}
	// replayItemWith adds one ui.tap breadcrumb per segment.
	if taps := x.byName("ui.tap"); len(taps) != 2 {
		t.Errorf("ui.tap: %d", len(taps))
	}
	if n := x.byName("navigation"); len(n) != 0 {
		t.Errorf("navigation breadcrumbs must not be copied: %+v", n)
	}
}

// enableLogs captures console output as Sentry logs, and the replay recording
// has the same lines as breadcrumbs: each line is one `console` record,
// whichever copy arrives first.
func TestConsoleLogsAndBreadcrumbsDeduplicated(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	start := int64(t0 * 1000)
	consoleLog := func(ts float64, msg string) map[string]any {
		return sentryLogEntry(ts, "info", msg, "", map[string]any{
			"sentry.origin":    map[string]any{"value": "auto.log.console", "type": "string"},
			"sentry.replay_id": map[string]any{"value": replay, "type": "string"},
		})
	}
	crumb := func(ms int64, msg string) string {
		return fmt.Sprintf(`,{"type":5,"timestamp":%d,"data":{"tag":"breadcrumb","payload":{"category":"console","level":"debug","message":%q}}}`, ms, msg)
	}
	// Segment 0 (breadcrumbs first), then the logs: "a" duplicated, "b" only a log.
	x.send(t, hdr("sentry.cocoa"), replayItemWith(replay, 0, start, device, crumb(start+100, "a")+crumb(start+200, "same text, later")))
	x.send(t, `{}`, logItem(consoleLog(t0+0.1003, "a"), consoleLog(t0+0.4, "b"), consoleLog(t0+30, "same text, later")))
	// Segment 1 after the logs: "b" duplicated, "c" only a breadcrumb.
	x.send(t, hdr("sentry.cocoa"), replayItemWith(replay, 1, start+5000, device, crumb(start+401, "b")+crumb(start+5100, "c")))

	var got []string
	for _, r := range x.byName("console") {
		got = append(got, r.body.(string))
		if r.attrs["session.id"] != sid1 {
			t.Errorf("console %v without the session", r.body)
		}
	}
	want := []string{"a", "same text, later", "b", "same text, later", "c"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("console records %q, want %q", got, want)
	}
	if n := len(x.byName("log")); n != 0 {
		t.Errorf("console output emitted as log records: %d", n)
	}
	// The replay id attribute resolved the logs (rule 2).
	for _, r := range x.byName("console") {
		if m := r.attrs["ouo.sentry.session_match"]; m != "replay" {
			t.Errorf("match %v", m)
		}
	}
}
