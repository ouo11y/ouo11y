package ouosentryreceiver

import (
	"strings"
	"testing"
	"time"

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

// A6: the allowlisted device and app context of an error; tags only when the project opts in.
func TestErrorContext(t *testing.T) {
	ev := map[string]any{"event_id": "e1", "timestamp": t0 + 5, "level": "error", "user": map[string]any{"id": device},
		"tags": map[string]any{"demo.action": "checkout", "hermes": "True"},
		"contexts": map[string]any{
			"device": map[string]any{"model": "iPhone19,2", "locale": "en_EG", "connection_type": "wifi", "thermal_state": "nominal", "free_memory": 1016315904,
				"memory_size": 34359738368, "low_power_mode": false, "simulator": true, "processor_count": 10, "screen_height_pixels": 874},
			"app": map[string]any{"view_names": []any{"Home", "Cart"}, "in_foreground": true, "app_start_time": "2026-10-14T09:59:58Z", "app_memory": 54116352,
				"device_app_hash": "7c9a2d0d", "app_identifier": "dev.ouo.sentrydemo"},
		},
		"request":   map[string]any{"url": "https://secret"},
		"extra":     map[string]any{"card": "4242"},
		"exception": map[string]any{"values": []any{map[string]any{"type": "Error", "value": "boom"}}}}
	for _, copyTags := range []bool{false, true} {
		x := newTx(t)
		x.p.CopyTags = copyTags
		x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
		x.send(t, hdr("sentry.javascript.react-native"), item("event", ev))
		a := x.byName("exception")[0].attrs
		want := map[string]any{"ouo.device.locale": "en_EG", "network.connection.type": "wifi", "ouo.device.thermal_state": "nominal", "ouo.device.free_memory": int64(1016315904),
			"ouo.device.memory_size": int64(34359738368), "ouo.device.low_power_mode": false, "ouo.device.simulator": true, "ouo.app.screen": "Cart",
			"ouo.app.in_foreground": true, "ouo.app.start_time": int64(1791971998000), "ouo.app.memory": int64(54116352)}
		for k, v := range want {
			if a[k] != v {
				t.Errorf("%s = %v, want %v", k, a[k], v)
			}
		}
		for k := range a {
			if strings.Contains(k, "processor") || strings.Contains(k, "hash") || strings.Contains(k, "request") || strings.Contains(k, "extra") || strings.Contains(k, "card") {
				t.Errorf("not allowlisted: %s", k)
			}
		}
		if got := a["ouo.sentry.tag.demo.action"]; (got == "checkout") != copyTags {
			t.Errorf("copy_tags %v: tag %v", copyTags, got)
		}
	}
}

// A7: unsymbolicated native frames keep their addresses, and the record names
// the debug images (with their UUIDs) the frames point into.
func TestNativeFrames(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("event", map[string]any{"event_id": "c1", "timestamp": t0, "level": "fatal",
		"exception": map[string]any{"values": []any{map[string]any{"type": "EXC_BAD_ACCESS", "mechanism": map[string]any{"type": "mach", "handled": false, "synthetic": true},
			"stacktrace": map[string]any{"frames": []any{
				map[string]any{"package": "/usr/lib/dyld", "instruction_addr": "0x00000001036e5e80", "image_addr": "0x00000001036b4000"},
				map[string]any{"instruction_addr": "0x000000010343c350", "image_addr": "0x0000000000000000"},
				map[string]any{"package": "/Users/me/sentrydemo.app/sentrydemo", "instruction_addr": "0x0000000102c7c9ec", "image_addr": "0x0000000102ac8000", "in_app": true},
			}}}}},
		"debug_meta": map[string]any{"images": []any{
			map[string]any{"type": "macho", "code_file": "/Users/me/sentrydemo.app/sentrydemo", "debug_id": "D6614443-A6DC-38CA-8CA6-8E62EA329489", "image_addr": "0x0000000102ac8000", "image_vmaddr": "0x0000000100000000", "image_size": 3522560},
			map[string]any{"type": "macho", "code_file": "dyld", "debug_id": "D341DDCB-7969-3A9C-8E03-0CF4751398A9", "image_addr": "0x00000001036b4000", "image_size": 786432},
			map[string]any{"type": "macho", "code_file": "/usr/lib/libunused.dylib", "debug_id": "11111111-0000-0000-0000-000000000000", "image_addr": "0x0000000190000000"},
		}}}))
	a := x.byName("exception")[0].attrs
	wantStack := "EXC_BAD_ACCESS\n  at ? (sentrydemo 0x0000000102c7c9ec 0x102ac8000 + 1788396) [in app]\n  at ? (? 0x000000010343c350)\n  at ? (dyld 0x00000001036e5e80 0x1036b4000 + 204416)"
	if a["exception.stacktrace"] != wantStack {
		t.Errorf("stacktrace:\n%s\nwant:\n%s", a["exception.stacktrace"], wantStack)
	}
	wantImages := `[{"type":"macho","code_file":"sentrydemo","debug_id":"D6614443-A6DC-38CA-8CA6-8E62EA329489","image_addr":"0x0000000102ac8000","image_vmaddr":"0x0000000100000000","image_size":3522560},` +
		`{"type":"macho","code_file":"dyld","debug_id":"D341DDCB-7969-3A9C-8E03-0CF4751398A9","image_addr":"0x00000001036b4000","image_size":786432}]`
	if a["ouo.sentry.debug_images"] != wantImages {
		t.Errorf("debug images:\n%s\nwant:\n%s", a["ouo.sentry.debug_images"], wantImages)
	}
}

func (x *tx) sendFrom(t *testing.T, origin, header string, items ...string) {
	t.Helper()
	body := header + "\n" + strings.Join(items, "\n") + "\n"
	env, err := ParseEnvelope([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	x.r.translate(t.Context(), job{project: x.p, body: []byte(body), receivedAt: time.Date(2026, 10, 14, 10, 30, 0, 0, time.UTC), clientAddr: "10.0.0.1", origin: origin}, env)
}

// N2: console lines printed while the app starts carry nothing to resolve
// them by; they join the session the same client starts around them.
func TestStartupLogs(t *testing.T) {
	console := map[string]any{"sentry.origin": map[string]any{"value": "auto.log.console", "type": "string"}}
	startup := func(ts float64, body string) map[string]any {
		e := sentryLogEntry(ts, "info", body, "efaa8d784a8b4594bad48c385b0fef44", console)
		delete(e["attributes"].(map[string]any), "device.model") // as observed: no user, replay or device attributes yet
		return e
	}
	x := newTx(t)
	x.sendFrom(t, "203.0.113.5,10.0.0.1", hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	other := session(sid2, true, "ok", 0, "2026-10-14T10:00:01Z")
	other["did"], other["started"] = "other-device", "2026-10-14T10:00:01Z"
	x.sendFrom(t, "198.51.100.9,10.0.0.1", hdr("sentry.cocoa"), item("session", other))
	x.sendFrom(t, "203.0.113.5,10.0.0.1", `{}`, logItem(startup(t0-0.06, "rum mode sentry"), startup(t0+0.03, `Running "main"`), startup(t0-60, "long before")))
	x.r.flushPendingLogs(t.Context(), true)
	got := map[any]any{}
	for _, r := range x.byName("console") {
		got[r.body] = r.attrs["session.id"]
	}
	if got["rum mode sentry"] != sid1 || got[`Running "main"`] != sid1 || got["long before"] != nil {
		t.Errorf("startup logs: %v", got)
	}

	// Two clients behind one address starting together: no guess.
	y := newTx(t)
	y.sendFrom(t, "10.9.9.9", hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	y.sendFrom(t, "10.9.9.9", hdr("sentry.cocoa"), item("session", other))
	y.sendFrom(t, "10.9.9.9", `{}`, logItem(startup(t0+0.5, "ambiguous")))
	y.r.flushPendingLogs(t.Context(), true)
	if c := y.byName("console"); len(c) != 1 || c[0].attrs["session.id"] != nil || c[0].attrs["ouo.sentry.session_match"] != "none" {
		t.Errorf("ambiguous startup log: %+v", c)
	}
}
