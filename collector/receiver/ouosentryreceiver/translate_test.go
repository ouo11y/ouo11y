package ouosentryreceiver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/receiver/receivertest"

	"github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver/internal/metadata"
)

// authCheckingLogs records the project the pipeline would stamp.
type authCheckingLogs struct {
	consumertest.LogsSink
	projects []string
}

func (a *authCheckingLogs) ConsumeLogs(ctx context.Context, ld plog.Logs) error {
	if au := client.FromContext(ctx).Auth; au != nil {
		a.projects = append(a.projects, fmt.Sprint(au.GetAttribute("username")))
	} else {
		a.projects = append(a.projects, "")
	}
	return a.LogsSink.ConsumeLogs(ctx, ld)
}

var _ consumer.Logs = (*authCheckingLogs)(nil)

type tx struct {
	r      *sentryReceiver
	logs   *authCheckingLogs
	traces *consumertest.TracesSink
	p      *project
}

func newTx(t *testing.T) *tx {
	cfg := createDefaultConfig().(*Config)
	cfg.Projects = []ProjectConfig{{SentryProjectID: "1", PublicKeys: []string{"k"}, Upstream: UpstreamNone, OuoProjectID: "mobile-store", ServiceName: "mobile-store-ios"}}
	r, err := newReceiver(receivertest.NewNopSettings(metadata.Type), cfg)
	if err != nil {
		t.Fatal(err)
	}
	x := &tx{r: r, logs: &authCheckingLogs{}, traces: new(consumertest.TracesSink)}
	r.setLogs(x.logs)
	r.setTraces(x.traces)
	x.p = r.projects["1/k"]
	return x
}

// send translates an envelope built from header + items synchronously.
func (x *tx) send(t *testing.T, header string, items ...string) {
	t.Helper()
	body := header + "\n" + strings.Join(items, "\n") + "\n"
	env, err := ParseEnvelope([]byte(body))
	if err != nil {
		t.Fatalf("envelope: %v\n%s", err, body)
	}
	x.r.translate(context.Background(), job{project: x.p, body: []byte(body), receivedAt: time.Date(2026, 10, 14, 10, 30, 0, 0, time.UTC), clientAddr: "10.0.0.7"}, env)
}

func item(typ string, payload any) string {
	b, _ := json.Marshal(payload)
	return fmt.Sprintf(`{"type":%q,"length":%d}`+"\n%s", typ, len(b), b)
}

func binItem(typ string, payload []byte) string {
	return fmt.Sprintf(`{"type":%q,"length":%d}`+"\n%s", typ, len(payload), payload)
}

type rec struct {
	name  string
	attrs map[string]any
	ts    time.Time
	body  any
	trace string
}

func (x *tx) records() []rec {
	var out []rec
	for _, ld := range x.logs.AllLogs() {
		for i := 0; i < ld.ResourceLogs().Len(); i++ {
			rl := ld.ResourceLogs().At(i)
			for j := 0; j < rl.ScopeLogs().Len(); j++ {
				lrs := rl.ScopeLogs().At(j).LogRecords()
				for k := 0; k < lrs.Len(); k++ {
					lr := lrs.At(k)
					name := lr.EventName()
					if name == "" {
						name = "replay"
					}
					var body any = lr.Body().AsString()
					if lr.Body().Type() == pcommon.ValueTypeBytes {
						body = lr.Body().Bytes().AsRaw()
					}
					out = append(out, rec{name: name, attrs: lr.Attributes().AsRaw(), ts: lr.Timestamp().AsTime(), body: body, trace: lr.TraceID().String()})
				}
			}
		}
	}
	return out
}

func (x *tx) byName(name string) []rec {
	var out []rec
	for _, r := range x.records() {
		if r.name == name {
			out = append(out, r)
		}
	}
	return out
}

func (x *tx) spans() []ptrace.Span {
	var out []ptrace.Span
	for _, td := range x.traces.AllTraces() {
		for i := 0; i < td.ResourceSpans().Len(); i++ {
			ss := td.ResourceSpans().At(i).ScopeSpans()
			for j := 0; j < ss.Len(); j++ {
				for k := 0; k < ss.At(j).Spans().Len(); k++ {
					out = append(out, ss.At(j).Spans().At(k))
				}
			}
		}
	}
	return out
}

const (
	sid1   = "7c7b6c2e4f0d4b3a9a3c1f2e3d4c5b6a"
	sid2   = "8d8c7d3f5a1e4c4ba4bd2a3f4e5d6c7b"
	device = "installation-0001"
	replay = "a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5b6"
	trace1 = "11112222333344445555666677778888"
)

func hdr(sdk string) string {
	return `{"event_id":"e0000000000000000000000000000001","sdk":{"name":"` + sdk + `","version":"8.57.0"}}`
}

func session(sid string, init bool, status string, errors int, ts string) map[string]any {
	return map[string]any{"sid": sid, "did": device, "init": init, "started": "2026-10-14T10:00:00.000Z", "timestamp": ts,
		"status": status, "errors": errors, "duration": 61.5, "attrs": map[string]any{"release": "com.acme.store@2.3.0+45", "environment": "production"}}
}

func TestTranslateJourney(t *testing.T) {
	x := newTx(t)

	// 1. Cold start: session init.
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00.000Z")))

	// 2. Handled error, sent with the session update it changed; carries the replay id.
	x.send(t, hdr("sentry.cocoa"),
		item("event", map[string]any{"event_id": "e1", "timestamp": 1791972010.5, "level": "error", "release": "com.acme.store@2.3.0+45",
			"user":     map[string]any{"id": device},
			"contexts": map[string]any{"trace": map[string]any{"trace_id": trace1, "span_id": "aaaabbbbccccdddd"}, "replay": map[string]any{"replay_id": replay}, "os": map[string]any{"name": "iOS", "version": "27.0"}, "device": map[string]any{"model": "iPhone18,1"}},
			"exception": map[string]any{"values": []any{
				map[string]any{"type": "URLError", "value": "timed out"},
				map[string]any{"type": "CheckoutError", "value": "payment failed", "mechanism": map[string]any{"type": "generic", "handled": true},
					"stacktrace": map[string]any{"frames": []any{map[string]any{"function": "main", "filename": "main.swift", "lineno": 1}, map[string]any{"function": "pay()", "filename": "Checkout.swift", "lineno": 42, "colno": 7, "in_app": true}}}},
			}}}),
		item("session", session(sid1, false, "ok", 1, "2026-10-14T10:00:10.500Z")))

	// 3. A screen-load transaction with a failing request: no session item, device rule.
	x.send(t, `{"event_id":"e2","trace":{"trace_id":"`+trace1+`","replay_id":"`+replay+`"}}`,
		item("transaction", map[string]any{"type": "transaction", "transaction": "CartScreen", "start_timestamp": 1791972020.0, "timestamp": 1791972021.25,
			"user":         map[string]any{"id": device},
			"contexts":     map[string]any{"trace": map[string]any{"trace_id": trace1, "span_id": "1000000000000001", "op": "ui.load", "status": "ok"}},
			"measurements": map[string]any{"time_to_initial_display": map[string]any{"value": 412.0, "unit": "millisecond"}},
			"spans": []any{
				map[string]any{"span_id": "1000000000000002", "parent_span_id": "1000000000000001", "op": "http.client", "description": "POST http://localhost:8082/api/checkout?fail=500", "start_timestamp": 1791972020.1, "timestamp": 1791972020.3, "status": "internal_error", "data": map[string]any{"http.response.status_code": "500"}},
				map[string]any{"span_id": "1000000000000003", "parent_span_id": "1000000000000001", "op": "http.client", "description": "GET http://localhost:8082/api/products", "start_timestamp": 1791972020.4, "timestamp": 1791972020.5, "status": "ok", "data": map[string]any{"http.request.method": "GET", "url": "http://localhost:8082/api/products", "http.response.status_code": 200}},
				map[string]any{"span_id": "1000000000000004", "parent_span_id": "1000000000000001", "op": "http.client", "description": "GET http://down.example/api", "start_timestamp": 1791972020.6, "timestamp": 1791972020.7, "status": "unknown_error"},
			}}))

	// 4. Background: exited with errors=3 though the bridge saw one error event.
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, false, "exited", 3, "2026-10-14T10:01:01.500Z")))

	// 5. New session, then a crash reported on the next launch with the crashed update.
	x.send(t, hdr("sentry.cocoa"), item("session", map[string]any{"sid": sid2, "did": device, "init": true, "started": "2026-10-14T10:05:00Z", "timestamp": "2026-10-14T10:05:00Z", "status": "ok", "attrs": map[string]any{"release": "com.acme.store@2.3.0+45"}}))
	x.send(t, hdr("sentry.cocoa"),
		item("event", map[string]any{"event_id": "e3", "timestamp": "2026-10-14T10:06:00Z", "level": "fatal", "user": map[string]any{"id": device},
			"exception": map[string]any{"values": []any{map[string]any{"type": "EXC_BAD_ACCESS", "value": "KERN_INVALID_ADDRESS", "mechanism": map[string]any{"type": "mach", "handled": false}}}}}),
		item("session", map[string]any{"sid": sid2, "did": device, "init": false, "started": "2026-10-14T10:05:00Z", "timestamp": "2026-10-14T10:06:00Z", "status": "crashed", "errors": 1, "attrs": map[string]any{"release": "com.acme.store@2.3.0+45"}}))

	// Sessions.
	if s := x.byName("session.start"); len(s) != 2 || s[0].attrs["session.id"] != sid1 || s[0].attrs["ouo.session.started_at"] != int64(1791972000000) || s[0].attrs["user.id"] != device {
		t.Errorf("session.start: %+v", s)
	}
	ends := x.byName("session.end")
	if len(ends) != 2 || ends[0].attrs["ouo.session.end_reason"] != "background" || ends[0].attrs["ouo.session.duration_ms"] != int64(61500) ||
		ends[1].attrs["ouo.session.end_reason"] != "crash" || ends[1].attrs["session.id"] != sid2 {
		t.Errorf("session.end: %+v", ends)
	}

	// Exceptions: 1 real + 2 synthetic for sid1, 1 fatal for sid2.
	exc := x.byName("exception")
	if len(exc) != 4 {
		t.Fatalf("exceptions: %d %+v", len(exc), exc)
	}
	e := exc[0].attrs
	if e["exception.type"] != "CheckoutError" || e["exception.message"] != "payment failed" || e["ouo.exception.fatal"] != false || e["ouo.exception.handled"] != true ||
		e["session.id"] != sid1 || e["ouo.sentry.session_match"] != "envelope" || exc[0].trace != trace1 {
		t.Errorf("handled exception: %+v trace %s", e, exc[0].trace)
	}
	wantStack := "CheckoutError: payment failed\n  at pay() (Checkout.swift:42:7) [in app]\n  at main (main.swift:1)\nCaused by: URLError: timed out"
	if e["exception.stacktrace"] != wantStack {
		t.Errorf("stacktrace:\n%s\nwant:\n%s", e["exception.stacktrace"], wantStack)
	}
	for _, s := range exc[1:3] {
		if s.attrs["exception.type"] != "sentry.unsampled_error" || s.attrs["ouo.sentry.synthetic"] != true || s.attrs["session.id"] != sid1 {
			t.Errorf("synthetic: %+v", s.attrs)
		}
	}
	if f := exc[3].attrs; f["ouo.exception.fatal"] != true || f["ouo.exception.handled"] != false || f["session.id"] != sid2 || f["ouo.sentry.mechanism"] != "mach" {
		t.Errorf("crash: %+v", f)
	}

	// Transaction: spans with the session, navigation and two failed requests.
	sp := x.spans()
	if len(sp) != 4 {
		t.Fatalf("spans: %d", len(sp))
	}
	for _, s := range sp {
		if v, _ := s.Attributes().Get("session.id"); v.Str() != sid1 {
			t.Errorf("span %s session.id %q", s.Name(), v.Str())
		}
		if s.TraceID().String() != trace1 {
			t.Errorf("span %s trace %s", s.Name(), s.TraceID())
		}
	}
	if m, _ := sp[0].Attributes().Get("ouo.sentry.session_match"); m.Str() != "replay" {
		t.Errorf("transaction session match %q, want replay (DSC replay_id learned from the error envelope)", m.Str())
	}
	if v, _ := sp[1].Attributes().Get("http.response.status_code"); v.Int() != 500 || sp[1].Kind() != ptrace.SpanKindClient || sp[1].Status().Code() != ptrace.StatusCodeError {
		t.Errorf("http span: %v %v %v", v, sp[1].Kind(), sp[1].Status().Code())
	}
	if v, _ := sp[0].Attributes().Get("ouo.sentry.measurement.time_to_initial_display"); v.Double() != 412 {
		t.Errorf("measurement %v", v)
	}
	nav := x.byName("navigation")
	if len(nav) != 1 || nav[0].attrs["url.path"] != "CartScreen" || nav[0].attrs["session.id"] != sid1 {
		t.Errorf("navigation: %+v", nav)
	}
	failed := x.byName("http.request.failed")
	if len(failed) != 2 || failed[0].attrs["http.request.method"] != "POST" || failed[0].attrs["url.full"] != "http://localhost:8082/api/checkout?fail=500" ||
		failed[0].attrs["http.response.status_code"] != int64(500) || failed[1].attrs["http.response.status_code"] != nil || failed[1].attrs["ouo.sentry.span_status"] != "unknown_error" {
		t.Errorf("http.request.failed: %+v", failed)
	}

	// Resource and project context.
	ld := x.logs.AllLogs()[1]
	res := ld.ResourceLogs().At(0).Resource().Attributes().AsRaw()
	if res["service.name"] != "mobile-store-ios" || res["service.version"] != "2.3.0" || res["ouo.app.build"] != "45" || res["ouo.platform"] != "mobile" ||
		res["os.name"] != "iOS" || res["device.model.identifier"] != "iPhone18,1" || res["deployment.environment.name"] != "production" || res["telemetry.sdk.name"] != "sentry.cocoa" {
		t.Errorf("resource: %+v", res)
	}
	for _, p := range x.logs.projects {
		if p != "mobile-store" {
			t.Errorf("client auth username %q, want mobile-store", p)
		}
	}
	for _, r := range x.records() {
		if r.attrs["event.name"] != r.name || r.attrs["ouo.platform"] != "mobile" {
			t.Errorf("%s: event.name %v platform %v", r.name, r.attrs["event.name"], r.attrs["ouo.platform"])
		}
	}
}

func TestBridgeRestartDoesNotBackfill(t *testing.T) {
	x := newTx(t)
	// The bridge never saw init: errors=5 is a baseline, not 5 synthetic exceptions.
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, false, "ok", 5, "2026-10-14T10:00:10Z")))
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, false, "exited", 6, "2026-10-14T10:00:20Z")))
	if n := len(x.byName("exception")); n != 1 {
		t.Errorf("exceptions after restart: %d, want 1 (the one new error)", n)
	}
	if n := len(x.byName("session.start")); n != 0 {
		t.Errorf("session.start without init: %d", n)
	}
	// A repeated end is not emitted twice.
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, false, "exited", 6, "2026-10-14T10:00:20Z")))
	if n := len(x.byName("session.end")); n != 1 {
		t.Errorf("session.end: %d", n)
	}
}

func TestUnmatchedEventHasNoSession(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.java.android"), item("event", map[string]any{"event_id": "e9", "level": "error", "message": "boom", "user": map[string]any{"id": "other"}}))
	exc := x.byName("exception")
	if len(exc) != 1 || exc[0].attrs["session.id"] != nil || exc[0].attrs["ouo.sentry.session_match"] != "none" || exc[0].attrs["exception.type"] != "Message" || exc[0].attrs["exception.message"] != "boom" {
		t.Errorf("unmatched: %+v", exc)
	}
	x.send(t, hdr("sentry.java.android"), item("event", map[string]any{"event_id": "e10", "level": "info", "logentry": map[string]any{"formatted": "user tapped buy"}}))
	if m := x.byName("sentry.message"); len(m) != 1 || m[0].body != "user tapped buy" || m[0].attrs["ouo.event.custom"] != true {
		t.Errorf("message: %+v", m)
	}
}

// ---- replay ----------------------------------------------------------------------

func msgpackMap(entries [][2][]byte) []byte {
	var b bytes.Buffer
	b.WriteByte(0x80 | byte(len(entries)))
	for _, e := range entries {
		b.WriteByte(0xd9)
		b.WriteByte(byte(len(e[0])))
		b.Write(e[0])
		b.WriteByte(0xc6)
		_ = binary.Write(&b, binary.BigEndian, uint32(len(e[1])))
		b.Write(e[1])
	}
	return b.Bytes()
}

var fakeMP4 = append([]byte{0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'm', 'p', '4', '2'}, bytes.Repeat([]byte{0x42}, 64)...)

func replayItem(replayID string, segment int, startMS int64, userID string) string {
	return replayItemWith(replayID, segment, startMS, userID, "")
}

// replayItemWith appends extra rrweb events (each starting with a comma) to the recording.
func replayItemWith(replayID string, segment int, startMS int64, userID, extra string) string {
	ev, _ := json.Marshal(map[string]any{"type": "replay_event", "replay_id": replayID, "segment_id": segment, "replay_type": "session",
		"timestamp": float64(startMS)/1000 + 5, "user": map[string]any{"id": userID}, "release": "com.acme.store@2.3.0+45"})
	recording := fmt.Sprintf(`{"segment_id":%d}`+"\n"+`[{"type":5,"timestamp":%d,"data":{"tag":"video","payload":{"segmentId":%d,"size":76,"duration":5000,"encoding":"h264","container":"mp4","height":844,"width":390,"frameCount":5,"frameRate":1,"frameRateType":"constant","left":0,"top":0}}},`+
		`{"type":3,"timestamp":%d,"data":{"source":2,"type":7,"id":0,"x":120.5,"y":410,"pointerType":2,"pointerId":0}},`+
		`{"type":3,"timestamp":%d,"data":{"source":2,"type":9,"id":0,"x":121,"y":411,"pointerType":2,"pointerId":0}},`+
		`{"type":5,"timestamp":%d,"data":{"tag":"breadcrumb","payload":{"category":"ui.tap"}}}%s]`, segment, startMS, segment, startMS+1000, startMS+1100, startMS+1200, extra)
	return binItem("replay_video", msgpackMap([][2][]byte{{[]byte("replay_event"), ev}, {[]byte("replay_recording"), []byte(recording)}, {[]byte("replay_video"), fakeMP4}}))
}

func (x *tx) chunks(t *testing.T) []videoChunk {
	var out []videoChunk
	for _, r := range x.records() {
		if r.attrs["ouo.replay.chunk"] != true {
			continue
		}
		if r.attrs["ouo.replay.kind"] != "video" || r.attrs["ouo.replay.encoding"] != "json" {
			t.Errorf("chunk attrs: %+v", r.attrs)
		}
		var c videoChunk
		if err := json.Unmarshal(r.body.([]byte), &c); err != nil {
			t.Fatal(err)
		}
		if r.attrs["session.id"] != c.SessionID || r.attrs["ouo.replay.seq"] != int64(c.Seq) {
			t.Errorf("chunk attrs vs body: %+v vs %s/%d", r.attrs, c.SessionID, c.Seq)
		}
		out = append(out, c)
	}
	return out
}

func TestReplayResolvedByReplayID(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	x.send(t, hdr("sentry.cocoa"),
		item("event", map[string]any{"event_id": "e1", "level": "error", "message": "x", "contexts": map[string]any{"replay": map[string]any{"replay_id": replay}}}),
		item("session", session(sid1, false, "ok", 1, "2026-10-14T10:00:05Z")))
	x.send(t, hdr("sentry.cocoa"), replayItem(replay, 0, 1791972000000, "someone-else"))
	x.send(t, hdr("sentry.cocoa"), replayItem(replay, 1, 1791972005000, "someone-else"))
	cs := x.chunks(t)
	if len(cs) != 2 {
		t.Fatalf("chunks: %d", len(cs))
	}
	c := cs[1]
	if c.Kind != "video" || c.SchemaVersion != 1 || c.SessionID != sid1 || c.Seq != 1 || c.StartedAt != 1791972005000 || c.EndedAt != 1791972010000 ||
		c.Viewport != (viewport{Width: 390, Height: 844, Scale: 1}) || c.Platform != "ios" || c.Video.FrameCount != 5 || c.Video.DurationMS != 5000 ||
		c.Source.ReplayID != replay || c.Source.Vendor != "sentry" || !c.Masked {
		t.Errorf("chunk: %+v", c)
	}
	if mp4, _ := base64.StdEncoding.DecodeString(c.Video.MP4); !bytes.Equal(mp4, fakeMP4) {
		t.Error("mp4 bytes changed")
	}
	if len(c.Touches) != 2 || c.Touches[0] != (touch{TS: 1791972006000, X: 120.5, Y: 410, Phase: "began"}) || c.Touches[1].Phase != "ended" {
		t.Errorf("touches: %+v", c.Touches)
	}
	// A second replay id for the same session is dropped (one session, one replay).
	x.send(t, hdr("sentry.cocoa"), replayItem("ffffffffffffffffffffffffffffffff", 0, 1791972010000, device))
	if n := len(x.chunks(t)); n != 2 {
		t.Errorf("conflicting replay emitted: %d chunks", n)
	}
}

func TestReplayHeldUntilSessionKnown(t *testing.T) {
	x := newTx(t)
	// The segment arrives first: nothing knows the replay id or the device yet.
	x.send(t, hdr("sentry.cocoa"), replayItem(replay, 0, 1791972001000, device))
	if n := len(x.chunks(t)); n != 0 {
		t.Fatalf("unresolved segment emitted: %d", n)
	}
	// The session init arrives: device rule resolves the held segment.
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	cs := x.chunks(t)
	if len(cs) != 1 || cs[0].SessionID != sid1 {
		t.Fatalf("held segment: %+v", cs)
	}
}

func TestMsgpack(t *testing.T) {
	m, err := decodeMsgpackMap(msgpackMap([][2][]byte{{[]byte("a"), []byte("1")}, {[]byte("bb"), nil}}))
	if err != nil || string(m["a"]) != "1" || len(m["bb"]) != 0 {
		t.Fatalf("%v %v", m, err)
	}
	// fixstr keys, bin8 and str16 values, map16 header.
	b := []byte{0xde, 0, 2, 0xa1, 'k', 0xc4, 2, 'h', 'i', 0xa2, 'k', '2', 0xda, 0, 3, 'a', 'b', 'c'}
	if m, err := decodeMsgpackMap(b); err != nil || string(m["k"]) != "hi" || string(m["k2"]) != "abc" {
		t.Fatalf("%v %v", m, err)
	}
	for _, bad := range [][]byte{nil, {0x81}, {0x81, 0xa1}, {0x81, 0xa1, 'k', 0xc6, 0, 0, 0, 9, 1}, {0x91, 0xa1, 'k'}, {0x81, 0x01, 0xa1, 'x'}} {
		if _, err := decodeMsgpackMap(bad); err == nil {
			t.Errorf("% x: want error", bad)
		}
	}
}

func TestHelpers(t *testing.T) {
	for in, want := range map[string][2]string{
		"com.acme.store@2.3.0+45": {"2.3.0", "45"}, "2.3.0": {"2.3.0", ""}, "app@1.0": {"1.0", ""}, "": {"", ""}, "a@b@3.1+7": {"3.1", "7"},
	} {
		if v, b := splitRelease(in); v != want[0] || b != want[1] {
			t.Errorf("splitRelease(%q) = %q %q", in, v, b)
		}
	}
	var ft struct {
		A flexTime `json:"a"`
		B flexTime `json:"b"`
		C flexTime `json:"c"`
	}
	if err := json.Unmarshal([]byte(`{"a":1791972000.25,"b":"2026-10-14T10:00:00.250Z","c":"2026-10-14T10:00:00.250000"}`), &ft); err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 14, 10, 0, 0, 250e6, time.UTC)
	if !ft.A.Equal(want) || !ft.B.Equal(want) || !ft.C.Equal(want) {
		t.Errorf("flexTime: %v %v %v", ft.A, ft.B, ft.C)
	}
	for _, c := range []struct{ sdk, os, platform, want string }{
		{"sentry.cocoa", "", "", "ios"},
		{"sentry.cocoa.react-native", "", "", "ios"},
		{"sentry.javascript.react-native", "", "cocoa", "ios"},
		{"sentry.javascript.react-native", "iOS", "javascript", "ios"},
		{"sentry.javascript.react-native", "Android", "", "android"},
		{"sentry.javascript.react-native", "", "javascript", ""},
		{"sentry.java.android", "", "", "android"},
		{"sentry.java", "", "java", "android"},
	} {
		if got := detectOS(c.sdk, c.os, c.platform); got != c.want {
			t.Errorf("detectOS(%q, %q, %q) = %q, want %q", c.sdk, c.os, c.platform, got, c.want)
		}
	}
}

func FuzzParseEnvelope(f *testing.F) {
	f.Add([]byte(sampleEnvelope))
	f.Add([]byte("{}\n{\"type\":\"replay_video\",\"length\":3}\nabc\n"))
	f.Fuzz(func(t *testing.T, b []byte) {
		env, err := ParseEnvelope(b)
		if err == nil {
			for _, it := range env.Items {
				if it.Type == "" {
					t.Fatal("item without type")
				}
			}
		}
	})
}

func FuzzDecodeMsgpackMap(f *testing.F) {
	f.Add(msgpackMap([][2][]byte{{[]byte("replay_event"), []byte("{}")}}))
	f.Add([]byte{0xdf, 0xff, 0xff, 0xff, 0xff})
	f.Fuzz(func(t *testing.T, b []byte) {
		_, _ = decodeMsgpackMap(b)
		_, _ = decodeReplayVideo(b)
	})
}

// A segment of a session the bridge never saw (it restarted mid-replay) is
// held; when the device's next session starts a minute later, the old segment
// must not claim it, or the new session's own replay is dropped as a conflict
// (found on a real run).
func TestHeldOldSegmentDoesNotClaimNextSession(t *testing.T) {
	x := newTx(t)
	start := int64(1791972000000) // 10:00:00, session() start
	x.send(t, hdr("sentry.cocoa"), replayItem("0000000000000000000000000000dead", 7, start-40000, device))
	x.send(t, hdr("sentry.cocoa"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00Z")))
	x.send(t, hdr("sentry.cocoa"), replayItem(replay, 0, start, device))
	x.send(t, hdr("sentry.cocoa"), replayItem(replay, 1, start+5000, device))
	cs := x.chunks(t)
	if len(cs) != 2 || cs[0].Source.ReplayID != replay || cs[1].Source.ReplayID != replay || cs[0].SessionID != sid1 {
		t.Fatalf("chunks: %+v", cs)
	}
	if x.r.pending.n != 1 {
		t.Errorf("the old segment should still be held (then expire): %d held", x.r.pending.n)
	}
}
