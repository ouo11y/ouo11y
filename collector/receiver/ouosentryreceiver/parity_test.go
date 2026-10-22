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
