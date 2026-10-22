package ouosentryreceiver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// goldenRequest is one request captured by tools/sentrytap from a real SDK.
type goldenRequest struct {
	Seq    int64               `json:"seq"`
	Time   time.Time           `json:"time"`
	Header map[string][]string `json:"header"`
	body   []byte
}

func loadGolden(t *testing.T, dir string) []goldenRequest {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []goldenRequest
	for _, e := range entries {
		var g goldenRequest
		b, err := os.ReadFile(filepath.Join(dir, e.Name(), "request.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, &g); err != nil {
			t.Fatal(err)
		}
		if g.body, err = os.ReadFile(filepath.Join(dir, e.Name(), "body.bin")); err != nil {
			t.Fatal(err)
		}
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

// replayGolden translates captured requests in order, as the worker would.
func replayGolden(t *testing.T, x *tx, reqs []goldenRequest) {
	t.Helper()
	replayGoldenEdited(t, x, reqs, nil)
}

// withoutReplay turns a capture into one of an app whose sessions were not
// sampled for replay: no replay_video items, no replay ids on events and in
// trace headers.
func withoutReplay(env *Envelope) {
	var items []Item
	for _, it := range env.Items {
		switch it.Type {
		case "replay_video":
			continue
		case "event", "transaction":
			var m map[string]any
			if json.Unmarshal(it.Payload, &m) == nil {
				if c, ok := m["contexts"].(map[string]any); ok {
					delete(c, "replay")
				}
				it.Payload, _ = json.Marshal(m)
			}
		}
		items = append(items, it)
	}
	env.Items = items
	env.Header.Trace = nil
}

func replayGoldenEdited(t *testing.T, x *tx, reqs []goldenRequest, edit func(*Envelope)) {
	t.Helper()
	for _, g := range reqs {
		enc := ""
		if v := g.Header["Content-Encoding"]; len(v) > 0 {
			enc = v[0]
		}
		plain, err := Decompress(g.body, enc, DefaultMaxTranslateBytes)
		if err != nil {
			t.Fatalf("request %d: %v", g.Seq, err)
		}
		env, err := ParseEnvelope(plain)
		if err != nil {
			t.Fatalf("request %d: %v", g.Seq, err)
		}
		if edit != nil {
			edit(env)
		}
		x.r.translate(context.Background(), job{project: x.p, encoding: enc, body: g.body, receivedAt: g.Time, clientAddr: "127.0.0.1"}, env)
	}
}

func TestGoldenDump(t *testing.T) {
	if os.Getenv("GOLDEN_DUMP") == "" {
		t.Skip("set GOLDEN_DUMP=journey|touch to print the translation of a capture")
	}
	x := newTx(t)
	replayGolden(t, x, loadGolden(t, filepath.Join("testdata/golden/ios-rn-8.30.0", os.Getenv("GOLDEN_DUMP"))))
	for _, r := range x.records() {
		a := r.attrs
		if a["ouo.replay.chunk"] == true {
			var c videoChunk
			_ = json.Unmarshal(r.body.([]byte), &c)
			t.Logf("%s REPLAY sid=%v seq=%d start=%d dur=%d vp=%v platform=%q touches=%d replay=%s", r.ts.Format("15:04:05.000"), c.SessionID, c.Seq, c.StartedAt, c.Video.DurationMS, c.Viewport, c.Platform, len(c.Touches), c.Source.ReplayID[:8])
			continue
		}
		t.Logf("%s %-20s sid=%v match=%v %v %v %v %v %v level=%v msg=%v", r.ts.Format("15:04:05.000"), r.name, a["session.id"], a["ouo.sentry.session_match"], a["exception.type"], a["ouo.exception.fatal"], a["ouo.session.end_reason"], a["url.path"], a["http.response.status_code"], a["ouo.sentry.level"], a["exception.message"])
	}
	for _, s := range x.spans() {
		v, _ := s.Attributes().Get("session.id")
		m, _ := s.Attributes().Get("ouo.sentry.session_match")
		t.Logf("SPAN %s %-30s sid=%s match=%s", s.StartTimestamp().AsTime().Format("15:04:05.000"), s.Name(), v.Str(), m.Str())
	}
}

// goldenSummary is what the assertions below check on a real capture.
type goldenSummary struct {
	starts, ends map[string]rec // by session id
	exceptions   []rec
	failed       []rec
	navigations  []rec
	chunks       []videoChunk
	spans        int
}

func summarize(t *testing.T, x *tx) goldenSummary {
	t.Helper()
	g := goldenSummary{starts: map[string]rec{}, ends: map[string]rec{}}
	for _, r := range x.records() {
		sid, _ := r.attrs["session.id"].(string)
		switch r.name {
		case "session.start":
			g.starts[sid] = r
		case "session.end":
			g.ends[sid] = r
		case "exception":
			g.exceptions = append(g.exceptions, r)
		case "http.request.failed":
			g.failed = append(g.failed, r)
		case "navigation":
			g.navigations = append(g.navigations, r)
		}
	}
	g.chunks = x.chunks(t)
	g.spans = len(x.spans())
	return g
}

// checkInvariants holds for every capture: every translated record and span
// has a session, and nothing lands in a session that had ended more than the
// grace period before it (the stale replay id bug), or before it started.
func checkInvariants(t *testing.T, x *tx, g goldenSummary) {
	t.Helper()
	ended := map[string]time.Time{}
	for sid, r := range g.ends {
		ended[sid] = r.ts
	}
	check := func(what, sid string, ts time.Time) {
		if sid == "" {
			t.Errorf("%s at %s has no session", what, ts.Format(time.TimeOnly))
			return
		}
		if end, ok := ended[sid]; ok && ts.After(end.Add(endedGrace)) {
			t.Errorf("%s at %s assigned to session %s that ended at %s", what, ts.Format(time.TimeOnly), sid, end.Format(time.TimeOnly))
		}
		if st, ok := g.starts[sid]; ok && ts.Before(st.ts.Add(-startSkew)) {
			t.Errorf("%s at %s assigned to session %s that started at %s", what, ts.Format(time.TimeOnly), sid, st.ts.Format(time.TimeOnly))
		}
	}
	for _, r := range x.records() {
		if r.attrs["ouo.replay.chunk"] == true || r.name == "session.start" || r.name == "session.end" {
			continue
		}
		sid, _ := r.attrs["session.id"].(string)
		check(r.name, sid, r.ts)
	}
	for _, s := range x.spans() {
		v, _ := s.Attributes().Get("session.id")
		check("span "+s.Name(), v.Str(), s.StartTimestamp().AsTime())
		// A5: client spans are named by method and carry the URL parts.
		if s.Kind() == ptrace.SpanKindClient {
			a := s.Attributes().AsRaw()
			if s.Name() != a["http.request.method"] || a["server.address"] == nil || a["server.port"] == nil || a["url.path"] == nil || a["url.scheme"] == nil {
				t.Errorf("client span %q: %+v", s.Name(), a)
			}
		}
	}
	// C5: failed requests at ERROR, as the ouo SDKs emit them.
	for _, ld := range x.logs.AllLogs() {
		lrs := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords()
		for i := 0; i < lrs.Len(); i++ {
			if r := lrs.At(i); r.EventName() == "http.request.failed" && r.SeverityNumber() != plog.SeverityNumberError {
				t.Errorf("http.request.failed at %v", r.SeverityNumber())
			}
		}
	}
	// One replay id per session and one session per replay id; seq contiguous from 0.
	bySID := map[string]string{}
	seqs := map[string][]int{}
	for _, c := range g.chunks {
		if prev, ok := bySID[c.SessionID]; ok && prev != c.Source.ReplayID {
			t.Errorf("session %s got replays %s and %s", c.SessionID, prev, c.Source.ReplayID)
		}
		bySID[c.SessionID] = c.Source.ReplayID
		seqs[c.SessionID] = append(seqs[c.SessionID], c.Seq)
		if c.Platform != "ios" || c.Viewport.Width == 0 || c.Video.DurationMS <= 0 {
			t.Errorf("chunk %s/%d: platform %q viewport %v duration %d", c.SessionID, c.Seq, c.Platform, c.Viewport, c.Video.DurationMS)
		}
		if mp4, err := base64.StdEncoding.DecodeString(c.Video.MP4); err != nil || len(mp4) < 12 || string(mp4[4:8]) != "ftyp" {
			t.Errorf("chunk %s/%d: mp4 not an ISO BMFF file", c.SessionID, c.Seq)
		}
		if _, ok := g.starts[c.SessionID]; !ok {
			t.Errorf("chunk %s/%d belongs to a session the capture never started", c.SessionID, c.Seq)
		}
	}
	for sid, s := range seqs {
		sort.Ints(s)
		for i, v := range s {
			if v != i {
				t.Errorf("session %s replay seqs %v not contiguous from 0", sid, s)
				break
			}
		}
	}
}

// TestGoldenJourney replays a real @sentry/react-native 8.30.0 (sentry-cocoa
// 9.30.1) journey: cold start, three screens, fetch ok/500/slow, handled
// error, message, unhandled rejection, 40 s background, native crash,
// relaunch (examples/sentry-mobile/scripts/journey.sh).
func TestGoldenJourney(t *testing.T) {
	x := newTx(t)
	replayGolden(t, x, loadGolden(t, "testdata/golden/ios-rn-8.30.0/journey"))
	g := summarize(t, x)
	checkInvariants(t, x, g)

	const first, second, third = "FE4D8E30-67B0-4A1A-8DD7-6DAEC314F893", "35BC7F65-B953-4BE0-8EF2-3A4276E72B61", "6537D56A-15CF-4A2E-BF17-DFAA0CC721CD"
	for _, sid := range []string{first, second, third} {
		if _, ok := g.starts[sid]; !ok {
			t.Errorf("no session.start for %s", sid)
		}
	}
	if r := g.ends[first]; r.attrs["ouo.session.end_reason"] != "background" {
		t.Errorf("first session end: %+v", r.attrs)
	}
	crash := g.ends[second]
	if crash.attrs["ouo.session.end_reason"] != "crash" {
		t.Errorf("second session end: %+v", crash.attrs)
	}
	var fatal []rec
	for _, e := range g.exceptions {
		if e.attrs["ouo.exception.fatal"] == true {
			fatal = append(fatal, e)
		}
	}
	// handled error, unhandled rejection, native crash; the info captureMessage
	// (synthetic exception) is a sentry.message, as Sentry's errors counter says (A1).
	if len(g.exceptions) != 3 || len(fatal) != 1 || fatal[0].attrs["exception.type"] != "EXC_BAD_ACCESS" || fatal[0].attrs["session.id"] != second {
		t.Errorf("exceptions: %d total, fatal %+v", len(g.exceptions), fatal)
	}
	// A7: native frames keep image, address and load address; the record
	// names the images (with UUIDs) the frames point into.
	if st, _ := fatal[0].attrs["exception.stacktrace"].(string); !strings.Contains(st, "at ? (sentrydemo 0x0000000102c7c9ec 0x102ac8000 + 1788396) [in app]") || strings.Contains(st, "at ? (/") {
		t.Errorf("native stack:\n%s", st)
	}
	var images []debugImage
	if err := json.Unmarshal([]byte(fmt.Sprint(fatal[0].attrs["ouo.sentry.debug_images"])), &images); err != nil || len(images) < 2 || len(images) >= 16 {
		t.Errorf("debug images (%v): %+v", err, images)
	}
	for _, img := range images {
		if img.DebugID == "" || strings.Contains(img.CodeFile, "/") {
			t.Errorf("debug image %+v", img)
		}
	}
	if !crash.ts.Equal(fatal[0].ts) {
		t.Errorf("crash session ends at %s, the crash happened at %s", crash.ts, fatal[0].ts)
	}
	if len(g.failed) != 1 || g.failed[0].attrs["http.response.status_code"] != int64(500) || g.failed[0].attrs["session.id"] != first {
		t.Errorf("http.request.failed: %+v", g.failed)
	}
	// Navigations after the background rotation carry the stale replay id of
	// the first session; they must land in the second one.
	var late int
	for _, n := range g.navigations {
		if n.ts.After(g.starts[second].ts) && n.ts.Before(crash.ts) {
			late++
			if n.attrs["session.id"] != second {
				t.Errorf("navigation %s at %s in %v, want %s", n.attrs["url.path"], n.ts.Format(time.TimeOnly), n.attrs["session.id"], second)
			}
		}
	}
	if late != 2 {
		t.Errorf("navigations in the second session: %d, want 2", late)
	}
	if len(g.chunks) != 16 {
		t.Errorf("replay chunks: %d, want 16 (one per replay_video item)", len(g.chunks))
	}
	if g.spans == 0 {
		t.Error("no spans")
	}
	for _, c := range g.chunks {
		if !c.Masked {
			t.Errorf("chunk %s/%d not masked: the capture ran with the default masking options", c.SessionID, c.Seq)
		}
	}
	// Breadcrumbs of the recordings: 9 answered fetches (the 500 comes from its
	// span), 8 console lines, 6 demo.action + 1 demo breadcrumbs, inactive and
	// background before the 40 s background phase.
	want := map[string]int{"http.request": 9, "console": 8, "breadcrumb": 7, "app.lifecycle": 2, "sentry.message": 1}
	for name, n := range want {
		if got := len(x.byName(name)); got != n {
			t.Errorf("%s records: %d, want %d", name, got, n)
		}
	}
	for _, r := range x.byName("http.request") {
		if r.attrs["http.response.status_code"] != int64(200) || r.attrs["url.full"] == nil {
			t.Errorf("http.request: %+v", r.attrs)
		}
	}
}

// TestGoldenJourneyWithoutReplay replays the journey as if no session had been
// sampled for replay (replaysSessionSampleRate below 1 in production): the
// timeline comes from the error events' breadcrumbs and the http.client
// spans (A8), with the same content the recordings gave.
func TestGoldenJourneyWithoutReplay(t *testing.T) {
	x := newTx(t)
	replayGoldenEdited(t, x, loadGolden(t, "testdata/golden/ios-rn-8.30.0/journey"), withoutReplay)
	g := summarize(t, x)
	checkInvariants(t, x, g)
	if len(g.chunks) != 0 {
		t.Fatalf("replay chunks: %d", len(g.chunks))
	}
	// 9 answered requests (spans and fetch breadcrumbs, one record each, as
	// the recordings gave); 8 console lines; 7 demo.action and
	// 1 demo breadcrumbs; foreground and active before the second session;
	// the 8 navigations as with a replay.
	want := map[string]int{"http.request": 9, "console": 8, "breadcrumb": 8, "app.lifecycle": 2, "navigation": 8, "exception": 3, "sentry.message": 1}
	for name, n := range want {
		if got := len(x.byName(name)); got != n {
			t.Errorf("%s records: %d, want %d", name, got, n)
		}
	}
	seen := map[string]bool{}
	for _, r := range x.records() {
		k := r.name + "|" + r.ts.String() + "|" + fmt.Sprint(r.body)
		if seen[k] {
			t.Errorf("duplicate %s at %s: %v", r.name, r.ts.Format(time.TimeOnly), r.body)
		}
		seen[k] = true
	}
	urls := map[any]bool{}
	for _, r := range x.byName("http.request") {
		urls[r.attrs["url.full"]] = true
	}
	if !urls["http://localhost:8082/api/cart"] || !urls["http://localhost:8082/api/products/p-1003"] {
		t.Errorf("http.request URLs: %v", urls)
	}
}

// TestGoldenTouch replays a capture with real taps and drags, and a JS fatal.
func TestGoldenTouch(t *testing.T) {
	x := newTx(t)
	replayGolden(t, x, loadGolden(t, "testdata/golden/ios-rn-8.30.0/touch"))
	g := summarize(t, x)
	checkInvariants(t, x, g)
	phases := map[string]int{}
	for _, c := range g.chunks {
		for _, tc := range c.Touches {
			phases[tc.Phase]++
			if tc.X < 0 || tc.Y < 0 || tc.X > float64(c.Viewport.Width) || tc.Y > float64(c.Viewport.Height) {
				t.Errorf("touch outside the %dx%d video: %+v", c.Viewport.Width, c.Viewport.Height, tc)
			}
			if tc.TS < c.StartedAt-1000 || tc.TS > c.EndedAt+1000 {
				t.Errorf("touch at %d outside its segment %d..%d", tc.TS, c.StartedAt, c.EndedAt)
			}
		}
	}
	if phases["began"] == 0 || phases["moved"] == 0 || phases["ended"] == 0 {
		t.Errorf("touch phases: %v, want began, moved and ended", phases)
	}
	var jsFatal bool
	for _, e := range g.exceptions {
		if e.attrs["ouo.exception.fatal"] == true && e.attrs["ouo.exception.handled"] == false {
			jsFatal = true
			if end := g.ends[e.attrs["session.id"].(string)]; end.attrs["ouo.session.end_reason"] != "crash" {
				t.Errorf("JS fatal session end: %+v", end.attrs)
			}
		}
	}
	if !jsFatal {
		t.Error("no fatal unhandled JS exception")
	}
	// Real taps: the touch boundary's breadcrumbs, labelled by the touched component.
	taps := x.byName("ui.tap")
	if len(taps) != 2 || taps[0].attrs["ouo.ui.target"] != "action-fetch-ok" || taps[1].attrs["ouo.ui.target"] != "HeaderHeightContext" {
		t.Errorf("ui.tap: %+v", taps)
	}
}

// TestGoldenRealTap replays a session driven with real simulator taps (no deep
// links): five taps, one swipe and a tap on empty space (2026-10-16). Every
// tap is in the replay twice, as a touch with a position (video points) and
// as a `ui.tap` breadcrumb with the touched component, the breadcrumb 80 to
// 150 ms after the touch start. The plugin pairs them (src/utils/taps.ts).
func TestGoldenRealTap(t *testing.T) {
	x := newTx(t)
	replayGolden(t, x, loadGolden(t, "testdata/golden/ios-rn-8.30.0/realtap"))
	g := summarize(t, x)
	checkInvariants(t, x, g)
	var starts []touch
	for _, c := range g.chunks {
		for _, tc := range c.Touches {
			if tc.Phase == "began" {
				starts = append(starts, tc)
			}
		}
	}
	taps := x.byName("ui.tap")
	wantTargets := []string{"action-browse-catalog", "action-fetch-ok", "HeaderShownContext", "action-fetch-500", "action-message", "HeaderShownContext"}
	if len(taps) < len(wantTargets) {
		t.Fatalf("ui.tap: %d, want at least %d", len(taps), len(wantTargets))
	}
	for i, want := range wantTargets {
		tap := taps[i]
		if tap.attrs["ouo.ui.target"] != want {
			t.Errorf("tap %d target %v, want %s", i, tap.attrs["ouo.ui.target"], want)
		}
		at := tap.ts.UnixMilli()
		var paired bool
		for _, s := range starts {
			if d := at - s.TS; d >= 0 && d <= 300 {
				paired = true
			}
		}
		if !paired {
			t.Errorf("tap %d (%s) at %d has no touch start up to 300 ms before it", i, want, at)
		}
	}
	// The tapped points (simulator tool, points) are the recorded positions.
	for _, p := range [][2]float64{{201, 418}, {201, 629}, {300, 700}, {201, 404}, {201, 660}, {330, 852}} {
		var found bool
		for _, s := range starts {
			if s.X == p[0] && s.Y == p[1] {
				found = true
			}
		}
		if !found {
			t.Errorf("no touch start at %v", p)
		}
	}
}

// TestGoldenShop replays a run with Sentry logs (enableLogs, which also
// captures console output), manual spans in new traces per flow, W3C
// traceparent to the backend and unmasked replay (journey.sh --shop-rounds 3).
func TestGoldenShop(t *testing.T) {
	x := newTx(t)
	replayGolden(t, x, loadGolden(t, "testdata/golden/ios-rn-8.30.0/shop"))
	g := summarize(t, x)
	checkInvariants(t, x, g)

	// 50 log entries: 30 Sentry.logger calls and 20 console lines; the replays
	// hold 18 console breadcrumbs, 17 of them duplicates of console log entries.
	want := map[string]int{"log": 30, "console": 21, "http.request": 45, "exception": 3, "sentry.message": 1}
	for name, n := range want {
		if got := len(x.byName(name)); got != n {
			t.Errorf("%s records: %d, want %d", name, got, n)
		}
	}
	for _, name := range []string{"log", "console"} {
		for _, r := range x.byName(name) {
			if m := r.attrs["ouo.sentry.session_match"]; m != "replay" && m != "trace" && m != "start" {
				t.Errorf("%s %q matched by %v", name, r.body, m)
			}
		}
	}
	levels := map[any]int{}
	for _, r := range x.byName("log") {
		levels[r.attrs["ouo.sentry.level"]]++
	}
	if levels["error"] != 3 || levels["warn"] != 1 || levels["debug"] != 3 {
		t.Errorf("log levels: %v", levels)
	}
	if n := len(x.r.pendingLogs.entries); n != 0 {
		t.Errorf("%d logs never found their session", n)
	}
	if len(g.chunks) != 25 {
		t.Errorf("replay chunks: %d, want 25", len(g.chunks))
	}
	for _, c := range g.chunks {
		if c.Masked {
			t.Errorf("chunk %s/%d masked: the app ran with masking off", c.SessionID, c.Seq)
		}
	}
	if x.r.pending.n != 0 {
		t.Errorf("replay segments still held: %d", x.r.pending.n)
	}
}

// TestGoldenSelfHosted replays the N2 run against self-hosted Sentry 26.10
// (2026-10-17, project/agents/sentry-demo/reports/sentry-self-hosted-n2-f4.html):
// real taps, Sentry logs, a native crash and a relaunch. Sentry's own counts
// for it: 2 sessions (1 crashed), 3 errors and 1 info message, 10 transactions.
func TestGoldenSelfHosted(t *testing.T) {
	x := newTx(t)
	replayGolden(t, x, loadGolden(t, "testdata/golden/ios-rn-8.30.0/selfhosted"))
	x.r.flushPendingLogs(context.Background(), true)
	g := summarize(t, x)
	checkInvariants(t, x, g) // also: no record without a session

	const first, second = "3C8B84B4-8E96-4A06-85D4-9E81A6ED2F77", "5E1BD07A-272D-4264-87BD-AB60D28FB709"
	if len(g.starts) != 2 || g.ends[first].attrs["ouo.session.end_reason"] != "crash" {
		t.Errorf("sessions: starts %d, first end %+v", len(g.starts), g.ends[first].attrs)
	}
	if len(g.exceptions) != 3 || len(x.byName("sentry.message")) != 1 {
		t.Errorf("exceptions %d, messages %d; Sentry: 3 errors and 1 info message", len(g.exceptions), len(x.byName("sentry.message")))
	}
	// A9.
	if p := g.starts[second].attrs["session.previous_id"]; p != first {
		t.Errorf("second session previous_id %v", p)
	}
	// N2: startup console lines (before sentry-cocoa's session init) land in
	// the session that starts next, and Running "main" is stored once per launch.
	running := map[any]int{}
	for _, r := range x.byName("console") {
		if r.body == `Running "main"` {
			running[r.attrs["session.id"]]++
		}
		if r.attrs["ouo.sentry.session_match"] == "start" && !strings.Contains(fmt.Sprint(r.body), "rum mode") && !strings.Contains(fmt.Sprint(r.body), "rollout") && r.body != `Running "main"` {
			t.Errorf("startup rule claimed %q", r.body)
		}
	}
	if running[first] != 1 || running[second] != 1 {
		t.Errorf(`Running "main" per session: %v`, running)
	}
	// A11: the back navigation Cart -> Home has no transaction, only its breadcrumb.
	var back bool
	for _, n := range g.navigations {
		if n.attrs["url.path"] == "Home" && n.attrs["ouo.navigation.from"] == "Cart" && n.attrs["ouo.navigation.source"] == "breadcrumb" && n.attrs["session.id"] == first {
			back = true
		}
	}
	if !back || len(g.navigations) != 5 {
		t.Errorf("navigations %d, back navigation %v", len(g.navigations), back)
	}
	// A2: log records carry release, environment, OS and device; A3: so does
	// the second session's start (a session-only envelope).
	for _, name := range []string{"log", "session.start"} {
		var res map[string]any
		for _, ld := range x.logs.AllLogs() {
			rl := ld.ResourceLogs().At(0)
			lrs := rl.ScopeLogs().At(0).LogRecords()
			for i := 0; i < lrs.Len(); i++ {
				if lrs.At(i).EventName() == name && lrs.At(i).Attributes().AsRaw()["session.id"] == second {
					res = rl.Resource().Attributes().AsRaw()
				}
			}
		}
		if res["service.version"] != "1.0.0" || res["deployment.environment.name"] == nil || res["os.name"] != "iOS" || res["os.version"] == nil || res["device.model.identifier"] == nil {
			t.Errorf("%s resource in the second session: %+v", name, res)
		}
	}
	// A6: errors carry the screen and device state.
	for _, e := range g.exceptions {
		// sentry-cocoa's crash report has no connection type; JS errors do.
		if e.attrs["ouo.device.locale"] == nil || (e.attrs["ouo.exception.fatal"] == false && (e.attrs["network.connection.type"] == nil || e.attrs["ouo.app.screen"] == nil)) {
			t.Errorf("exception %v without device context: %+v", e.attrs["exception.type"], e.attrs)
		}
	}
}
