package ouosentryreceiver

import (
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
)

// Bridge parity fixes from the gap report (project/tracker/checklist.md, section 2).

// A1: captureMessage below error sends a synthetic exception; it is a message.
func TestSyntheticMessageIsNotAnError(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00.000Z")))
	synthetic := map[string]any{"type": "generic", "handled": true, "synthetic": true}
	x.send(t, hdr("sentry.javascript.react-native"),
		item("event", map[string]any{"event_id": "m1", "timestamp": 1791972005.0, "level": "info", "message": "promo sheet opened", "user": map[string]any{"id": device},
			"exception": map[string]any{"values": []any{map[string]any{"value": "promo sheet opened", "mechanism": synthetic}}}}))
	// A warning with a real exception stays an exception, a fatal synthetic one (native crash) too.
	x.send(t, hdr("sentry.javascript.react-native"),
		item("event", map[string]any{"event_id": "m2", "timestamp": 1791972006.0, "level": "warning", "user": map[string]any{"id": device},
			"exception": map[string]any{"values": []any{map[string]any{"type": "TypeError", "value": "x is undefined"}}}}))
	x.send(t, hdr("sentry.javascript.react-native"),
		item("event", map[string]any{"event_id": "m3", "timestamp": 1791972007.0, "user": map[string]any{"id": device},
			"exception": map[string]any{"values": []any{map[string]any{"type": "EXC_BAD_ACCESS", "mechanism": synthetic}}}}))

	msgs := x.byName("sentry.message")
	if len(msgs) != 1 || msgs[0].body != "promo sheet opened" || msgs[0].attrs["ouo.sentry.level"] != "info" || msgs[0].attrs["session.id"] != sid1 {
		t.Errorf("sentry.message: %+v", msgs)
	}
	exc := x.byName("exception")
	if len(exc) != 2 || exc[0].attrs["ouo.sentry.event_id"] != "m2" || exc[1].attrs["ouo.sentry.event_id"] != "m3" {
		t.Errorf("exceptions: %+v", exc)
	}
	// Sentry's counter says 2; no synthetic unsampled error is added.
	x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, false, "exited", 2, "2026-10-14T10:00:10.000Z")))
	if n := len(x.byName("exception")); n != 2 {
		t.Errorf("exceptions after the exited update: %d, want 2", n)
	}
}

// A5 and C5: client spans named by method with the URL parts; failed requests at ERROR.
func TestHTTPClientSpans(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00.000Z")))
	x.send(t, `{"event_id":"t1"}`,
		item("transaction", map[string]any{"type": "transaction", "transaction": "Product", "start_timestamp": 1791972020.0, "timestamp": 1791972021.0,
			"user":     map[string]any{"id": device},
			"contexts": map[string]any{"trace": map[string]any{"trace_id": trace1, "span_id": "1000000000000001", "op": "navigation"}},
			"spans": []any{
				map[string]any{"span_id": "1000000000000002", "op": "http.client", "description": "GET http://localhost:8082/api/products/p-1001", "start_timestamp": 1791972020.1, "timestamp": 1791972020.2,
					"data": map[string]any{"http.method": "GET", "url": "http://localhost:8082/api/products/p-1001", "http.response.status_code": 200}},
				map[string]any{"span_id": "1000000000000003", "op": "http.client", "description": "POST https://api.example.com/checkout?fail=500", "start_timestamp": 1791972020.3, "timestamp": 1791972020.4,
					"status": "internal_error", "data": map[string]any{"http.response.status_code": 500}},
				map[string]any{"span_id": "1000000000000004", "op": "http.client", "description": "fetch", "start_timestamp": 1791972020.5, "timestamp": 1791972020.6},
			}}))
	sp := x.spans()
	if len(sp) != 4 {
		t.Fatalf("spans: %d", len(sp))
	}
	want := []struct {
		name, addr, scheme, path string
		port                     int64
	}{
		{"GET", "localhost", "http", "/api/products/p-1001", 8082},
		{"POST", "api.example.com", "https", "/checkout", 443},
		{"HTTP", "", "", "", 0},
	}
	for i, w := range want {
		s := sp[i+1]
		a := s.Attributes().AsRaw()
		if s.Name() != w.name || a["url.scheme"] != nilIfEmpty(w.scheme) || a["url.path"] != nilIfEmpty(w.path) || a["server.address"] != nilIfEmpty(w.addr) {
			t.Errorf("span %d: name %q attrs %+v", i, s.Name(), a)
		}
		if w.port != 0 && a["server.port"] != w.port {
			t.Errorf("span %d: server.port %v, want %d", i, a["server.port"], w.port)
		}
	}
	failed := x.byName("http.request.failed")
	if len(failed) != 1 {
		t.Fatalf("http.request.failed: %+v", failed)
	}
	lr := x.logs.AllLogs()[len(x.logs.AllLogs())-1].ResourceLogs().At(0).ScopeLogs().At(0).LogRecords()
	for i := 0; i < lr.Len(); i++ {
		if r := lr.At(i); r.EventName() == "http.request.failed" && (r.SeverityNumber() != plog.SeverityNumberError || r.SeverityText() != "ERROR") {
			t.Errorf("http.request.failed severity %v %q, want ERROR like the ouo SDK", r.SeverityNumber(), r.SeverityText())
		}
	}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// resourceOf returns the resource of the log batch that holds the first record named name.
func (x *tx) resourceOf(t *testing.T, name string) map[string]any {
	t.Helper()
	for _, ld := range x.logs.AllLogs() {
		rl := ld.ResourceLogs().At(0)
		lrs := rl.ScopeLogs().At(0).LogRecords()
		for i := 0; i < lrs.Len(); i++ {
			if lrs.At(i).EventName() == name {
				return rl.Resource().Attributes().AsRaw()
			}
		}
	}
	t.Fatalf("no %s record", name)
	return nil
}

// A2: a log-only envelope builds its resource from the entries' attributes.
func TestLogResource(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	env := map[string]any{"sentry.environment": map[string]any{"value": "production", "type": "string"}, "os.version": map[string]any{"value": "27.0", "type": "string"}}
	tr := transactionItem(trace1, t0+1)
	tr["user"] = map[string]any{"id": device}
	x.send(t, `{}`, item("transaction", tr))
	x.send(t, `{}`, logItem(sentryLogEntry(t0+2, "info", "cart opened", trace1, env)))
	res := x.resourceOf(t, "log")
	want := map[string]any{"service.version": "2.3.0", "ouo.app.build": "45", "ouo.sentry.release": "com.acme.store@2.3.0+45", "deployment.environment.name": "production",
		"os.name": "iOS", "os.version": "27.0", "device.model.identifier": "iPhone18,1", "telemetry.sdk.name": "sentry.javascript.react-native"}
	for k, v := range want {
		if res[k] != v {
			t.Errorf("log resource %s = %v, want %v", k, res[k], v)
		}
	}
	if a := x.byName("log")[0].attrs; a["os.name"] != nil || a["device.model"] != nil || a["sentry.release"] != nil {
		t.Errorf("SDK attributes copied onto the record: %+v", a)
	}
}

// A3: session-only and replay envelopes get the device context the session's
// (or the device's previous session's) events carried.
func TestDeviceContextFromState(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	if res := x.resourceOf(t, "session.start"); res["os.version"] != nil {
		t.Errorf("first session.start of an unknown device: %+v", res)
	}
	x.send(t, hdr("sentry.cocoa"), item("event", map[string]any{"event_id": "e1", "timestamp": t0 + 5, "level": "error", "user": map[string]any{"id": device},
		"contexts":  map[string]any{"os": map[string]any{"name": "iOS", "version": "27.0"}, "device": map[string]any{"model": "iPhone18,1"}},
		"exception": map[string]any{"values": []any{map[string]any{"type": "Error", "value": "boom"}}}}),
		item("session", session(sid1, false, "ok", 1, "2026-10-14T10:00:05Z")))
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, false, "exited", 1, "2026-10-14T10:01:00Z")))
	x.send(t, hdr("sentry.cocoa"), item("session", map[string]any{"sid": sid2, "did": device, "init": true, "started": "2026-10-14T10:05:00Z", "timestamp": "2026-10-14T10:05:00Z", "status": "ok"}))
	for _, name := range []string{"session.end", "session.start"} {
		var res map[string]any
		for _, ld := range x.logs.AllLogs()[2:] {
			rl := ld.ResourceLogs().At(0)
			if rl.ScopeLogs().At(0).LogRecords().At(0).EventName() == name {
				res = rl.Resource().Attributes().AsRaw()
			}
		}
		if res["os.name"] != "iOS" || res["os.version"] != "27.0" || res["device.model.identifier"] != "iPhone18,1" {
			t.Errorf("%s resource: %+v", name, res)
		}
	}
}

// A9: session.start and session.end name the device's previous session.
func TestPreviousSession(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, false, "exited", 0, "2026-10-14T10:01:00Z")))
	x.send(t, hdr("sentry.cocoa"), item("session", map[string]any{"sid": sid2, "did": device, "init": true, "started": "2026-10-14T10:05:00Z", "timestamp": "2026-10-14T10:05:00Z", "status": "ok"}))
	x.send(t, hdr("sentry.cocoa"), item("session", map[string]any{"sid": sid2, "did": device, "started": "2026-10-14T10:05:00Z", "timestamp": "2026-10-14T10:06:00Z", "status": "exited"}))
	starts, ends := x.byName("session.start"), x.byName("session.end")
	if starts[0].attrs["session.previous_id"] != nil || ends[0].attrs["session.previous_id"] != nil {
		t.Errorf("first session has a previous one: %+v", starts[0].attrs)
	}
	if starts[1].attrs["session.previous_id"] != sid1 || ends[1].attrs["session.previous_id"] != sid1 {
		t.Errorf("second session: start %+v end %+v", starts[1].attrs, ends[1].attrs)
	}
}

func navTransaction(screen string, start float64) map[string]any {
	return map[string]any{"event_id": "n-" + screen, "type": "transaction", "transaction": screen, "start_timestamp": start, "timestamp": start + 0.3, "user": map[string]any{"id": device},
		"contexts": map[string]any{"trace": map[string]any{"trace_id": trace1, "span_id": "bbbbbbbbbbbbbbbb", "op": "navigation"}}}
}

func navCrumb(from, to string, ts float64) map[string]any {
	d := map[string]any{"to": to}
	if from != "" {
		d["from"] = from
	}
	return map[string]any{"timestamp": ts, "category": "navigation", "type": "navigation", "message": "Navigation to " + to, "data": d, "level": "info"}
}

// A11: a back navigation without a transaction comes from its breadcrumb;
// navigations with a transaction are not doubled by theirs, nor by the copies
// every later error carries.
func TestBackNavigationFromBreadcrumbs(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	x.send(t, `{}`, item("transaction", navTransaction("Home", t0+1)))
	x.send(t, `{}`, item("transaction", navTransaction("Cart", t0+10)))
	crumbs := []any{navCrumb("", "Home", t0+1.02), navCrumb("Home", "Cart", t0+10.01), navCrumb("Cart", "Home", t0+20)}
	for i, id := range []string{"e1", "e2"} {
		x.send(t, hdr("sentry.javascript.react-native"), item("event", map[string]any{"event_id": id, "timestamp": t0 + 30 + float64(i), "level": "error", "user": map[string]any{"id": device},
			"contexts":    map[string]any{"replay": map[string]any{"replay_id": replay}},
			"exception":   map[string]any{"values": []any{map[string]any{"type": "Error", "value": "boom"}}},
			"breadcrumbs": crumbs}))
	}
	// A transaction arriving after its breadcrumb is not doubled either.
	x.send(t, `{}`, item("transaction", navTransaction("Product", t0+40)))
	x.send(t, hdr("sentry.javascript.react-native"), item("event", map[string]any{"event_id": "e3", "timestamp": t0 + 41, "level": "error", "user": map[string]any{"id": device},
		"exception": map[string]any{"values": []any{map[string]any{"type": "Error", "value": "boom"}}}, "breadcrumbs": []any{navCrumb("Home", "Product", t0+40.02)}}))

	nav := x.byName("navigation")
	want := []struct{ path, from, source string }{{"Home", "", "transaction"}, {"Cart", "Home", "transaction"}, {"Home", "Cart", "breadcrumb"}, {"Product", "Home", "transaction"}}
	if len(nav) != len(want) {
		t.Fatalf("navigations: %d %+v", len(nav), nav)
	}
	for i, w := range want {
		a := nav[i].attrs
		if a["url.path"] != w.path || a["ouo.navigation.from"] != nilIfEmpty(w.from) || a["ouo.navigation.source"] != w.source || a["session.id"] != sid1 {
			t.Errorf("navigation %d: %+v, want %+v", i, a, w)
		}
	}
}

// A8: a session without a replay gets its timeline from the error events'
// breadcrumbs and its successful requests from http.client spans, each once.
func TestTimelineWithoutReplay(t *testing.T) {
	x := newTx(t)
	// The previous session's breadcrumbs ride along on the new session's errors.
	x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	x.send(t, `{"event_id":"t1"}`,
		item("transaction", map[string]any{"type": "transaction", "transaction": "load", "start_timestamp": t0 + 2, "timestamp": t0 + 3, "user": map[string]any{"id": device},
			"contexts": map[string]any{"trace": map[string]any{"trace_id": trace1, "span_id": "1000000000000001", "op": "ui.action"}},
			"spans": []any{
				map[string]any{"span_id": "2000000000000001", "op": "http.client", "description": "GET http://api/products", "start_timestamp": t0 + 2.1, "timestamp": t0 + 2.2, "data": map[string]any{"http.response.status_code": 200}},
				map[string]any{"span_id": "2000000000000002", "op": "http.client", "description": "GET http://api/fail", "start_timestamp": t0 + 2.3, "timestamp": t0 + 2.4, "status": "internal_error", "data": map[string]any{"http.response.status_code": 503}},
			}}))
	crumbs := []any{
		map[string]any{"timestamp": t0 - 90, "category": "touch", "message": "Touch event within element: old"},
		map[string]any{"timestamp": t0 + 1, "category": "started", "message": "Breadcrumb Tracking"},
		map[string]any{"timestamp": t0 + 1.5, "category": "touch", "message": "Touch event within element: Fetch products", "data": map[string]any{"path": []any{map[string]any{"label": "Fetch products"}}}},
		map[string]any{"timestamp": t0 + 2.2, "category": "fetch", "type": "http", "data": map[string]any{"method": "GET", "url": "http://api/products", "status_code": 200, "__span": "2000000000000001"}},
		map[string]any{"timestamp": t0 + 2.5, "category": "fetch", "type": "http", "data": map[string]any{"method": "GET", "url": "http://api/cart", "status_code": 200, "__span": "2000000000000009"}},
		map[string]any{"timestamp": t0 + 3, "category": "console", "level": "log", "message": "cart loaded"},
		map[string]any{"timestamp": t0 + 4, "category": "demo.action", "message": "checkout", "data": map[string]any{"step": 2}},
		map[string]any{"timestamp": t0 + 4.1, "category": "ui.lifecycle", "data": map[string]any{"screen": "RNSScreen"}},
		map[string]any{"timestamp": t0 + 4.2, "category": "sentry.transaction", "message": "abc"},
	}
	x.send(t, hdr("sentry.javascript.react-native"), item("event", map[string]any{"event_id": "e1", "timestamp": t0 + 5, "level": "error", "user": map[string]any{"id": device},
		"exception": map[string]any{"values": []any{map[string]any{"type": "Error", "value": "one"}}}, "breadcrumbs": crumbs}))
	// The second error repeats them, plus a native copy stamped 40 ms later and a new tap.
	more := append(append([]any{}, crumbs...),
		map[string]any{"timestamp": "2026-10-14T10:00:03.040Z", "category": "console", "level": "log", "message": "cart loaded", "origin": "react-native"},
		map[string]any{"timestamp": t0 + 6, "category": "touch", "message": "Touch event within element: Pay"})
	x.send(t, hdr("sentry.javascript.react-native"), item("event", map[string]any{"event_id": "e2", "timestamp": t0 + 7, "level": "error", "user": map[string]any{"id": device},
		"exception": map[string]any{"values": []any{map[string]any{"type": "Error", "value": "two"}}}, "breadcrumbs": more}))

	http := x.byName("http.request")
	if len(http) != 2 || http[0].attrs["url.full"] != "http://api/products" || http[0].trace != trace1 || http[1].attrs["url.full"] != "http://api/cart" {
		t.Errorf("http.request: %+v", http)
	}
	taps := x.byName("ui.tap")
	if len(taps) != 2 || taps[0].attrs["ouo.ui.target"] != "Fetch products" || taps[1].attrs["ouo.ui.target"] != "Pay" {
		t.Errorf("ui.tap: %+v", taps)
	}
	if c := x.byName("console"); len(c) != 1 || c[0].body != "cart loaded" {
		t.Errorf("console: %+v", c)
	}
	if b := x.byName("breadcrumb"); len(b) != 1 || b[0].attrs["ouo.breadcrumb.category"] != "demo.action" || b[0].attrs["ouo.breadcrumb.data.step"] != "2" {
		t.Errorf("breadcrumb: %+v", b)
	}
	for _, r := range x.records() {
		if r.attrs["session.id"] != sid1 {
			t.Errorf("%s without the session: %+v", r.name, r.attrs)
		}
	}

	// With a replay, the recording brings the breadcrumbs and requests.
	y := newTx(t)
	y.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	y.send(t, hdr("sentry.javascript.react-native"), item("event", map[string]any{"event_id": "e1", "timestamp": t0 + 5, "level": "error", "user": map[string]any{"id": device},
		"contexts":  map[string]any{"replay": map[string]any{"replay_id": replay}},
		"exception": map[string]any{"values": []any{map[string]any{"type": "Error", "value": "one"}}}, "breadcrumbs": crumbs}))
	for _, name := range []string{"http.request", "ui.tap", "console", "breadcrumb"} {
		if n := len(y.byName(name)); n != 0 {
			t.Errorf("session with a replay: %d %s records from event breadcrumbs", n, name)
		}
	}
}
