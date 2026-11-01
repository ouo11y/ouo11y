package ouosentryreceiver

import (
	"context"
	"strings"
	"testing"
	"time"
)

// errorEnvelope sends a handled error with the session update it changed, so
// the session, its replay id and the error's event id are known.
func errorEnvelope(t *testing.T, x *tx, eventID string) {
	t.Helper()
	x.send(t, hdr("sentry.javascript.react-native"), item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00.000Z")))
	x.send(t, hdr("sentry.javascript.react-native"),
		item("event", map[string]any{"event_id": eventID, "timestamp": 1791972010.5, "level": "error", "user": map[string]any{"id": device},
			"contexts":  map[string]any{"replay": map[string]any{"replay_id": replay}},
			"exception": map[string]any{"values": []any{map[string]any{"type": "PayError", "value": "declined"}}}}),
		item("session", session(sid1, false, "ok", 1, "2026-10-14T10:00:10.500Z")))
}

func feedbackItem(fb map[string]any, extra map[string]any) string {
	ev := map[string]any{"event_id": "0123456789abcdef0123456789abcdef", "type": "feedback", "level": "info", "timestamp": 1791972030.25, "contexts": map[string]any{"feedback": fb}}
	for k, v := range extra {
		ev[k] = v
	}
	return item("feedback", ev)
}

func TestFeedbackItem(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.javascript.react-native"),
		feedbackItem(map[string]any{"message": "  The pay button does nothing ", "contact_email": "ana@example.com", "name": "Ana"}, map[string]any{
			"user":        map[string]any{"id": device},
			"contexts":    map[string]any{"feedback": map[string]any{"message": "  The pay button does nothing ", "contact_email": "ana@example.com", "name": "Ana"}, "trace": map[string]any{"trace_id": trace1, "span_id": "aaaabbbbccccdddd"}},
			"breadcrumbs": []any{map[string]any{"timestamp": 1791972020.0, "category": "navigation", "data": map[string]any{"from": "Home", "to": "Cart"}}},
		}),
		item("session", session(sid1, true, "ok", 0, "2026-10-14T10:00:00.000Z")))

	fs := x.byName("feedback")
	if len(fs) != 1 {
		t.Fatalf("feedback records: %d", len(fs))
	}
	f := fs[0]
	want := map[string]any{
		"ouo.feedback.message": "The pay button does nothing", "ouo.feedback.contact": "ana@example.com",
		"ouo.feedback.id": "01234567-89ab-cdef-0123-456789abcdef", "ouo.sentry.event_id": "0123456789abcdef0123456789abcdef",
		"session.id": sid1, "ouo.sentry.session_match": "envelope", "event.name": "feedback", "ouo.platform": "mobile",
	}
	for k, v := range want {
		if f.attrs[k] != v {
			t.Errorf("%s = %v, want %v", k, f.attrs[k], v)
		}
	}
	if f.body != "The pay button does nothing" || !f.ts.Equal(time.Unix(1791972030, 250_000_000)) || f.trace != trace1 {
		t.Errorf("body %q ts %v trace %s", f.body, f.ts, f.trace)
	}
	if _, ok := f.attrs["ouo.feedback.screenshot"]; ok {
		t.Error("the bridge adds no frame to a replay: no screenshot flag")
	}
	// Its breadcrumbs are the session's timeline events before it (section 9b).
	if nav := x.byName("navigation"); len(nav) != 1 || nav[0].attrs["url.path"] != "Cart" {
		t.Errorf("breadcrumb navigation: %+v", nav)
	}
}

func TestFeedbackContactNameAndEmptyMessage(t *testing.T) {
	x := newTx(t)
	x.send(t, hdr("sentry.cocoa"), feedbackItem(map[string]any{"message": "slow", "name": "Ana"}, nil))
	x.send(t, hdr("sentry.cocoa"), feedbackItem(map[string]any{"message": "   ", "contact_email": "a@b"}, nil))
	x.send(t, hdr("sentry.cocoa"), item("feedback", map[string]any{"event_id": "e9", "type": "feedback"})) // no contexts.feedback
	fs := x.byName("feedback")
	if len(fs) != 1 || fs[0].attrs["ouo.feedback.contact"] != "Ana" {
		t.Fatalf("records: %+v", fs)
	}
	if fs[0].attrs["ouo.sentry.session_match"] != "none" {
		t.Errorf("no session known: %v", fs[0].attrs["ouo.sentry.session_match"])
	}
}

func TestFeedbackLongTextIsCut(t *testing.T) {
	x := newTx(t)
	long := strings.Repeat("é", maxFeedbackText) // 2 bytes each
	x.send(t, hdr("sentry.cocoa"), feedbackItem(map[string]any{"message": long, "contact_email": long}, nil))
	f := x.byName("feedback")[0]
	for _, k := range []string{"ouo.feedback.message", "ouo.feedback.contact"} {
		v := f.attrs[k].(string)
		if len(v) > maxFeedbackText+len("…") || !strings.HasSuffix(v, "…") || strings.ContainsRune(v, '�') {
			t.Errorf("%s: %d bytes", k, len(v))
		}
	}
}

func TestFeedbackResolvesByReplayIDAndAssociatedEvent(t *testing.T) {
	x := newTx(t)
	errorEnvelope(t, x, "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1")
	// contexts.feedback.replay_id only (the JS replay integration's way): rule 2.
	x.send(t, hdr("sentry.javascript.react-native"), feedbackItem(map[string]any{"message": "a", "replay_id": replay}, nil))
	// No replay, user or trace: the event it is about.
	x.send(t, hdr("sentry.javascript.react-native"), feedbackItem(map[string]any{"message": "b", "associated_event_id": "E1E1E1E1-E1E1-E1E1-E1E1-E1E1E1E1E1E1"}, nil))
	got := map[string]string{}
	for _, f := range x.byName("feedback") {
		got[f.body.(string)] = f.attrs["session.id"].(string) + "/" + f.attrs["ouo.sentry.session_match"].(string)
	}
	if got["a"] != sid1+"/replay" || got["b"] != sid1+"/event" {
		t.Errorf("resolution: %v", got)
	}
}

func TestUserReport(t *testing.T) {
	x := newTx(t)
	errorEnvelope(t, x, "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2")
	x.send(t, `{"event_id":"e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2"}`, item("user_report", map[string]any{"event_id": "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2", "name": "Ana", "email": "ana@example.com", "comments": "It crashed when I paid"}))
	x.send(t, `{}`, item("user_report", map[string]any{"event_id": "ffffffffffffffffffffffffffffffff", "name": "Bo", "comments": "who am I"}))
	x.send(t, `{}`, item("user_report", map[string]any{"event_id": "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2", "comments": " "}))
	// The unknown error's report is held (section 9c); shutdown emits it.
	if fs := x.byName("feedback"); len(fs) != 1 {
		t.Fatalf("records before the hold ends: %d", len(fs))
	}
	x.r.flushPendingLogs(context.Background(), true)
	fs := x.byName("feedback")
	if len(fs) != 2 {
		t.Fatalf("records: %d", len(fs))
	}
	a, b := fs[0].attrs, fs[1].attrs
	if a["ouo.feedback.message"] != "It crashed when I paid" || a["ouo.feedback.contact"] != "ana@example.com" || a["session.id"] != sid1 || a["ouo.sentry.session_match"] != "event" {
		t.Errorf("report on a known error: %v", a)
	}
	if _, ok := a["ouo.feedback.id"]; ok {
		t.Error("a user report has no id of its own")
	}
	if b["ouo.feedback.contact"] != "Bo" || b["session.id"] != nil || b["ouo.sentry.session_match"] != "none" {
		t.Errorf("report on an unknown error: %v", b)
	}
}

// A report that arrives before its error is held, keyed by the error's event
// id, and takes the error's session when the error arrives (section 9c). One
// whose error never arrives goes out without a session after the hold.
func TestUserReportHeldUntilItsError(t *testing.T) {
	x := newTx(t)
	x.send(t, `{}`, item("user_report", map[string]any{"event_id": "E3E3E3E3-E3E3-E3E3-E3E3-E3E3E3E3E3E3", "email": "ana@example.com", "comments": "early"}))
	x.send(t, `{}`, item("user_report", map[string]any{"event_id": "e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4", "name": "Bo", "comments": "never"}))
	x.send(t, `{}`, item("user_report", map[string]any{"event_id": "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5", "comments": "  "}))
	if fs := x.byName("feedback"); len(fs) != 0 {
		t.Fatalf("emitted before the error is known: %+v", fs)
	}
	if n := len(x.r.pendingLogs.entries); n != 2 {
		t.Fatalf("held reports: %d, want 2 (an empty one is not held)", n)
	}
	errorEnvelope(t, x, "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3")
	fs := x.byName("feedback")
	if len(fs) != 1 {
		t.Fatalf("records after the error: %d", len(fs))
	}
	a := fs[0].attrs
	if fs[0].body != "early" || a["session.id"] != sid1 || a["ouo.sentry.session_match"] != "event" || a["ouo.feedback.contact"] != "ana@example.com" {
		t.Errorf("held report: %v", a)
	}
	// The hold ends: the next flush (an envelope or the 5 s tick) emits the other without a session.
	if n := len(x.r.pendingLogs.entries); n != 1 {
		t.Fatalf("held after the error: %d", n)
	}
	x.r.pendingLogs.entries[0].until = time.Now().Add(-time.Second)
	x.r.flushPendingLogs(context.Background(), false)
	fs = x.byName("feedback")
	if len(fs) != 2 || fs[1].body != "never" || fs[1].attrs["session.id"] != nil || fs[1].attrs["ouo.sentry.session_match"] != "none" {
		t.Fatalf("expired report: %+v", fs)
	}
	if n := len(x.r.pendingLogs.entries); n != 0 {
		t.Errorf("held entries left: %d", n)
	}
}

// Beyond maxPendingLogs held entries, a report goes out at once without a session.
func TestUserReportHoldOverflow(t *testing.T) {
	x := newTx(t)
	filler := pendingLog{group: &logGroup{j: job{project: x.p}}, until: time.Now().Add(time.Hour)}
	for range maxPendingLogs {
		x.r.pendingLogs.entries = append(x.r.pendingLogs.entries, filler)
	}
	x.send(t, `{}`, item("user_report", map[string]any{"event_id": "e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6", "comments": "full"}))
	fs := x.byName("feedback")
	if len(fs) != 1 || fs[0].attrs["ouo.sentry.session_match"] != "none" || len(x.r.pendingLogs.entries) != maxPendingLogs {
		t.Fatalf("overflow: %+v, held %d", fs, len(x.r.pendingLogs.entries))
	}
}

func TestEventIndexIsBounded(t *testing.T) {
	st := newSessionState(StateConfig{})
	x, _ := st.upsert("p", "s", "d", time.Now())
	for i := 0; i <= maxEventsPerSession; i++ {
		st.learnEvent(x, strings.Repeat(string(rune('a'+i%26)), 2)+strings.Repeat("0", 28)+string(rune('a'+i/26)))
	}
	if len(x.eventIDs) != maxEventsPerSession || len(st.byEvent) != maxEventsPerSession {
		t.Fatalf("kept %d ids, index %d", len(x.eventIDs), len(st.byEvent))
	}
	if st.byEventID("p", "aa"+strings.Repeat("0", 28)+"a") != nil || st.byEventID("p", x.eventIDs[0]) != x {
		t.Error("the oldest id is forgotten first")
	}
	st.remove(x)
	if len(st.byEvent) != 0 {
		t.Errorf("remove leaves %d ids", len(st.byEvent))
	}
}

func TestUUIDOf(t *testing.T) {
	for in, want := range map[string]string{
		"0123456789ABCDEF0123456789abcdef":     "01234567-89ab-cdef-0123-456789abcdef",
		"01234567-89ab-cdef-0123-456789abcdef": "01234567-89ab-cdef-0123-456789abcdef",
		"e1":                                   "", "": "", "zz23456789abcdef0123456789abcdef": "",
	} {
		if got := uuidOf(in); got != want {
			t.Errorf("uuidOf(%q) = %q", in, got)
		}
	}
}
