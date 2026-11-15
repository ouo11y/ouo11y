package muninn

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	collogspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"

	"github.com/ouo11y/ouo11y/services/muninn/internal/config"
	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
)

const (
	sess   = "0123456789abcdef0123456789abcdef"
	rep    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	strm   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	strm2  = "cccccccccccccccccccccccccccccccc"
	proj   = "shop-web"
	ingTok = "it"
	rdTok  = "rt"
	admTok = "at"
)

// --- fixtures -----------------------------------------------------------------------

func sv(s string) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: s}}
}
func iv(i int64) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: i}}
}
func bv(b bool) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_BoolValue{BoolValue: b}}
}
func dv(f float64) *commonpb.AnyValue {
	return &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: f}}
}

type rec struct {
	event string
	attrs map[string]*commonpb.AnyValue
	body  []byte
}

func chunk(stream string, seq int64, format, encoding string, body []byte) rec {
	sum := sha256.Sum256(body)
	return rec{event: eventChunk, body: body, attrs: map[string]*commonpb.AnyValue{
		"session.id": sv(sess), "ouo.replay.id": sv(rep), "ouo.replay.stream.id": sv(stream),
		"ouo.replay.sequence": iv(seq), "ouo.replay.segment.index": iv(0), "ouo.replay.keyframe": bv(seq == 0),
		"ouo.replay.start_time": iv(1000 + seq*5000), "ouo.replay.end_time": iv(1000 + seq*5000 + 4999),
		"ouo.replay.format": sv(format), "ouo.replay.encoding": sv(encoding),
		"ouo.replay.sha256": sv(hex.EncodeToString(sum[:])), "ouo.replay.byte_size": iv(int64(len(body))),
		"ouo.replay.masked": bv(true), "ouo.replay.mode": sv("session"), "ouo.view.id": sv("view-1"),
	}}
}

func ended(stream, state string, last int64) rec {
	a := map[string]*commonpb.AnyValue{
		"session.id": sv(sess), "ouo.replay.id": sv(rep), "ouo.replay.stream.id": sv(stream),
		"ouo.replay.end_state": sv(state), "ouo.replay.end_reason": sv("pagehide"),
	}
	if last >= 0 {
		a["ouo.replay.last_sequence"] = iv(last)
	}
	return rec{event: eventEnded, attrs: a}
}

func (r rec) with(k string, v *commonpb.AnyValue) rec {
	a := map[string]*commonpb.AnyValue{}
	for kk, vv := range r.attrs {
		a[kk] = vv
	}
	if v == nil {
		delete(a, k)
	} else {
		a[k] = v
	}
	r.attrs = a
	return r
}

func gz(s string) []byte {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	_, _ = w.Write([]byte(s))
	_ = w.Close()
	return b.Bytes()
}

func request(project, scope string, recs ...rec) []byte {
	var lrs []*logspb.LogRecord
	for _, r := range recs {
		lr := &logspb.LogRecord{EventName: r.event, TimeUnixNano: 1794400000000000000}
		for k, v := range r.attrs {
			lr.Attributes = append(lr.Attributes, &commonpb.KeyValue{Key: k, Value: v})
		}
		if r.body != nil {
			lr.Body = &commonpb.AnyValue{Value: &commonpb.AnyValue_BytesValue{BytesValue: r.body}}
		}
		lrs = append(lrs, lr)
	}
	res := &resourcepb.Resource{}
	if project != "" {
		res.Attributes = []*commonpb.KeyValue{{Key: "ouo.project.id", Value: sv(project)}, {Key: "service.name", Value: sv("shop")}}
	}
	b, _ := proto.Marshal(&collogspb.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{{
		Resource:  res,
		ScopeLogs: []*logspb.ScopeLogs{{Scope: &commonpb.InstrumentationScope{Name: scope}, LogRecords: lrs}},
	}}})
	return b
}

type harness struct {
	t   *testing.T
	srv *Server
	h   http.Handler
	st  store.Store
	now time.Time
}

func newHarness(t *testing.T, mutate ...func(*config.Config)) *harness {
	t.Helper()
	cfg := config.Defaults()
	cfg.Auth.IngestToken, cfg.Auth.ReadToken, cfg.Auth.AdminToken = ingTok, rdTok, admTok
	for _, m := range mutate {
		m(&cfg)
	}
	st, err := store.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return newHarnessStore(t, cfg, st)
}

func newHarnessStore(t *testing.T, cfg config.Config, st store.Store) *harness {
	h := &harness{t: t, st: st, now: time.UnixMilli(1794400000000)}
	h.srv = New(cfg, st, "test")
	h.srv.SetClock(func() time.Time { return h.now })
	if err := h.srv.Init(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.h = h.srv.Handler()
	return h
}

func (h *harness) do(method, path string, body []byte, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.h.ServeHTTP(w, r)
	return w
}

// send posts an OTLP request and returns status and the partial-success values.
func (h *harness) send(body []byte, hdr ...map[string]string) (int, int64, string) {
	m := map[string]string{"Content-Type": "application/x-protobuf", "Authorization": "Bearer " + ingTok}
	for _, x := range hdr {
		for k, v := range x {
			m[k] = v
		}
	}
	w := h.do("POST", "/otlp/v1/logs", body, m)
	if w.Code != 200 {
		return w.Code, 0, w.Body.String()
	}
	var resp collogspb.ExportLogsServiceResponse
	if err := proto.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		h.t.Fatal(err)
	}
	return 200, resp.GetPartialSuccess().GetRejectedLogRecords(), resp.GetPartialSuccess().GetErrorMessage()
}

func (h *harness) mustStore(recs ...rec) {
	h.t.Helper()
	code, rej, msg := h.send(request(proj, scopeReplay, recs...))
	if code != 200 || rej != 0 {
		h.t.Fatalf("send: %d rejected=%d %s", code, rej, msg)
	}
}

func (h *harness) get(path string, hdr ...map[string]string) *httptest.ResponseRecorder {
	m := map[string]string{"Authorization": "Bearer " + rdTok}
	for _, x := range hdr {
		for k, v := range x {
			m[k] = v
		}
	}
	return h.do("GET", path, nil, m)
}

func (h *harness) manifest(replay string) (int, replayInfo) {
	w := h.get(fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays/%s", proj, sess, replay))
	var ri replayInfo
	if w.Code == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &ri); err != nil {
			h.t.Fatal(err)
		}
	}
	return w.Code, ri
}

func chunkPath(stream string, seq int) string {
	return fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays/%s/streams/%s/chunks/%d", proj, sess, rep, stream, seq)
}

// --- tests --------------------------------------------------------------------------

// The four format ids the founder fixed, plus an unknown one (MUN-7): stored and
// served byte for byte, with Content-Encoding only for gzip (MUN-34).
func TestFormatsStoredByteForByte(t *testing.T) {
	h := newHarness(t)
	cases := []struct{ format, enc string }{
		{"rrweb/2", "gzip"}, {"ouo-frames/3", "identity"}, {"ouo-video/1", "identity"},
		{"ouo-wireframe/1", "gzip"}, {"someday.format_x/9", "identity"},
	}
	bodies := map[int][]byte{}
	for i, c := range cases {
		body := []byte(fmt.Sprintf("\x00\xffopaque %s bytes \x1f\x8b %d", c.format, i))
		if c.enc == "gzip" {
			body = gz(fmt.Sprintf(`{"type":%d}`+"\n", i))
		}
		bodies[i] = body
		h.mustStore(chunk(strm, int64(i), c.format, c.enc, body))
	}
	for i, c := range cases {
		w := h.get(chunkPath(strm, i))
		if w.Code != 200 {
			t.Fatalf("%s: %d", c.format, w.Code)
		}
		if !bytes.Equal(w.Body.Bytes(), bodies[i]) {
			t.Errorf("%s: body differs", c.format)
		}
		if got := w.Header().Get("X-Ouo-Replay-Format"); got != c.format {
			t.Errorf("format header %q", got)
		}
		wantCE := ""
		if c.enc == "gzip" {
			wantCE = "gzip"
		}
		if got := w.Header().Get("Content-Encoding"); got != wantCE {
			t.Errorf("%s: Content-Encoding %q, want %q", c.format, got, wantCE)
		}
		sum := sha256.Sum256(bodies[i])
		if got := w.Header().Get("ETag"); got != `"`+hex.EncodeToString(sum[:])+`"` {
			t.Errorf("etag %s", got)
		}
	}
	if ct := h.get(chunkPath(strm, 0)).Header().Get("Content-Type"); ct != "application/x-ndjson" {
		t.Errorf("rrweb content type %q", ct)
	}
	if ct := h.get(chunkPath(strm, 2)).Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("video content type %q", ct)
	}
	// Unknown attributes are kept (MUN-6).
	_, ri := h.manifest(rep)
	if got := ri.Streams[0].Chunks[0].Attributes["ouo.view.id"]; got != "view-1" {
		t.Errorf("ouo.view.id = %v", got)
	}
}

// MUN-5, MUN-11, MUN-12: each bad record is rejected with its reason, neighbours stored.
func TestRejections(t *testing.T) {
	good := chunk(strm, 0, "rrweb/2", "gzip", gz("x"))
	bad := func(r rec) rec { return r }
	cases := []struct {
		name, scope, project, reason string
		r                            rec
	}{
		{"scope", "other", proj, "not_replay", good},
		{"project", scopeReplay, "", "no_project", good},
		{"project syntax", scopeReplay, "Shop", "no_project", good},
		{"event", scopeReplay, proj, "unknown_event", rec{event: "page.view", attrs: good.attrs, body: good.body}},
		{"session id", scopeReplay, proj, "bad_id", good.with("session.id", sv("ABC"))},
		{"replay id", scopeReplay, proj, "bad_id", good.with("ouo.replay.id", sv("../../etc"))},
		{"sequence", scopeReplay, proj, "bad_id", good.with("ouo.replay.sequence", iv(1_000_000_000))},
		{"missing", scopeReplay, proj, "missing_attribute", good.with("ouo.replay.masked", nil)},
		{"type", scopeReplay, proj, "bad_attribute", good.with("ouo.replay.keyframe", sv("yes"))},
		{"encoding", scopeReplay, proj, "bad_attribute", good.with("ouo.replay.encoding", sv("br"))},
		{"format", scopeReplay, proj, "bad_attribute", good.with("ouo.replay.format", sv("RRWEB 2"))},
		{"times", scopeReplay, proj, "bad_attribute", good.with("ouo.replay.start_time", iv(1<<50))},
		{"ref", scopeReplay, proj, "bad_attribute", good.with("ouo.replay.ref", sv("muninn:/x"))},
		{"buffer no trigger", scopeReplay, proj, "missing_attribute", good.with("ouo.replay.mode", sv("buffer"))},
		{"hash", scopeReplay, proj, "hash_mismatch", good.with("ouo.replay.sha256", sv(strings.Repeat("0", 64)))},
		{"size", scopeReplay, proj, "size_mismatch", good.with("ouo.replay.byte_size", iv(3))},
		{"empty", scopeReplay, proj, "size_mismatch", bad(chunk(strm, 0, "rrweb/2", "gzip", []byte{}))},
		{"too large", scopeReplay, proj, "too_large", chunk(strm, 0, "rrweb/2", "identity", make([]byte, 1<<20+1))},
		{"attr size", scopeReplay, proj, "bad_attribute", good.with("big", sv(strings.Repeat("a", 17<<10)))},
		{"end state", scopeReplay, proj, "bad_attribute", ended(strm, "done", 3)},
		{"nan", scopeReplay, proj, "bad_attribute", good.with("x", dv(math.NaN()))},
		{"inf in end record", scopeReplay, proj, "bad_attribute", ended(strm, "complete", 0).with("x", dv(math.Inf(1)))},
		{"nan in array", scopeReplay, proj, "bad_attribute", good.with("x", &commonpb.AnyValue{Value: &commonpb.AnyValue_ArrayValue{ArrayValue: &commonpb.ArrayValue{Values: []*commonpb.AnyValue{dv(math.NaN())}}}})},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			// The bad record and a valid neighbour in one request (neighbour in a valid resource).
			var req collogspb.ExportLogsServiceRequest
			_ = proto.Unmarshal(request(c.project, c.scope, c.r), &req)
			var ok collogspb.ExportLogsServiceRequest
			_ = proto.Unmarshal(request(proj, scopeReplay, chunk(strm2, 0, "rrweb/2", "gzip", gz("n"))), &ok)
			req.ResourceLogs = append(req.ResourceLogs, ok.ResourceLogs...)
			body, _ := proto.Marshal(&req)
			code, rej, msg := h.send(body)
			if code != 200 || rej != 1 || !strings.HasPrefix(msg, c.reason+":") {
				t.Fatalf("got %d rejected=%d %q, want reason %s", code, rej, msg, c.reason)
			}
			if w := h.get(fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays/%s/streams/%s/chunks/0", proj, sess, rep, strm2)); w.Code != 200 {
				t.Fatalf("neighbour not stored: %d", w.Code)
			}
		})
	}
}

// MUN-13, MUN-14: same chunk twice is a success; same identity with other bytes is a
// conflict and the first bytes stay.
func TestDuplicateAndConflict(t *testing.T) {
	h := newHarness(t)
	first := chunk(strm, 0, "rrweb/2", "gzip", gz("first"))
	h.mustStore(first)
	h.mustStore(first)
	code, rej, msg := h.send(request(proj, scopeReplay, chunk(strm, 0, "rrweb/2", "gzip", gz("second"))))
	if code != 200 || rej != 1 || !strings.HasPrefix(msg, "conflict:") {
		t.Fatalf("conflict: %d %d %q", code, rej, msg)
	}
	if !bytes.Equal(h.get(chunkPath(strm, 0)).Body.Bytes(), first.body) {
		t.Fatal("first write did not stay")
	}
}

// MUN-8: two end records for one stream, the first stays.
func TestEndRecordFirstStays(t *testing.T) {
	h := newHarness(t)
	h.mustStore(chunk(strm, 0, "rrweb/2", "gzip", gz("a")), ended(strm, "complete", 0))
	h.mustStore(ended(strm, "partial", 5))
	_, ri := h.manifest(rep)
	if e := ri.Streams[0].End; e == nil || e.EndState != "complete" || *e.LastSequence != 0 {
		t.Fatalf("end = %+v", e)
	}
	if ri.State != "complete" {
		t.Fatalf("state %s", ri.State)
	}
}

// MUN-18, MUN-30 to MUN-33: order does not matter; gaps, idle timeout and a late chunk.
func TestManifestState(t *testing.T) {
	h := newHarness(t)
	// End record first, then chunks 3, 0, 1 (2 missing).
	h.mustStore(ended(strm, "complete", 3))
	h.mustStore(chunk(strm, 3, "rrweb/2", "gzip", gz("3")), chunk(strm, 0, "rrweb/2", "gzip", gz("0")))
	h.mustStore(chunk(strm, 1, "rrweb/2", "gzip", gz("1")))
	code, ri := h.manifest(rep)
	if code != 200 || ri.State != "partial" || ri.ChunkCount != 3 {
		t.Fatalf("code %d state %s count %d", code, ri.State, ri.ChunkCount)
	}
	st := ri.Streams[0]
	if len(st.Missing) != 1 || st.Missing[0] != [2]int64{2, 2} {
		t.Fatalf("missing %v", st.Missing)
	}
	for i, c := range st.Chunks {
		if want := []int64{0, 1, 3}[i]; c.Sequence != want {
			t.Fatalf("order %v", st.Chunks)
		}
	}
	// A second stream without an end record is open, then partial after the idle timeout.
	h.mustStore(chunk(strm2, 0, "rrweb/2", "gzip", gz("x")), chunk(strm2, 1, "rrweb/2", "gzip", gz("y")))
	if _, ri = h.manifest(rep); ri.State != "open" {
		t.Fatalf("want open, got %s", ri.State)
	}
	h.now = h.now.Add(31 * time.Minute)
	if _, ri = h.manifest(rep); ri.State != "partial" {
		t.Fatalf("want partial after idle, got %s", ri.State)
	}
	// The late chunk closes the gap: stream 1 complete, stream 2 still partial.
	h.mustStore(chunk(strm, 2, "rrweb/2", "gzip", gz("2")), ended(strm2, "complete", 1))
	if _, ri = h.manifest(rep); ri.State != "complete" {
		t.Fatalf("want complete, got %s (%+v)", ri.State, ri.Streams)
	}
	// List of the session.
	w := h.get(fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays", proj, sess))
	var list struct {
		Replays []replaySummary `json:"replays"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Replays) != 1 || list.Replays[0].ChunkCount != 6 || list.Replays[0].StreamCount != 2 || list.Replays[0].Formats[0] != "rrweb/2" {
		t.Fatalf("list %+v", list)
	}
}

// MUN-15, MUN-40 to MUN-43: delete, then a late chunk is accepted and not stored; a new
// replay in the same session is stored; tombstones go after the TTL.
func TestDeleteAndTombstone(t *testing.T) {
	h := newHarness(t)
	h.mustStore(chunk(strm, 0, "rrweb/2", "gzip", gz("a")))
	del := h.do("DELETE", fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays/%s", proj, sess, rep), nil, map[string]string{"Authorization": "Bearer " + rdTok})
	if del.Code != 204 {
		t.Fatalf("delete %d", del.Code)
	}
	if code, _ := h.manifest(rep); code != 404 {
		t.Fatalf("manifest after delete %d", code)
	}
	h.mustStore(chunk(strm, 1, "rrweb/2", "gzip", gz("late")))
	if w := h.get(chunkPath(strm, 1)); w.Code != 404 {
		t.Fatalf("late chunk readable: %d", w.Code)
	}
	objs, _ := h.st.List(context.Background(), h.srv.keys.replay("anonymous", proj, sess, rep))
	if len(objs) != 1 || !strings.HasSuffix(objs[0].Key, "deleted.json") {
		t.Fatalf("objects after delete: %v", objs)
	}
	// A new replay in the same session is stored (MUN-41: no session tombstone).
	other := chunk(strm, 0, "rrweb/2", "gzip", gz("b")).with("ouo.replay.id", sv(strings.Repeat("d", 32)))
	h.mustStore(other)
	if code, _ := h.manifest(strings.Repeat("d", 32)); code != 200 {
		t.Fatalf("new replay %d", code)
	}
	// Session delete removes it, idempotently.
	for range 2 {
		if w := h.do("DELETE", fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays", proj, sess), nil, map[string]string{"Authorization": "Bearer " + rdTok}); w.Code != 204 {
			t.Fatalf("session delete %d", w.Code)
		}
	}
	// Past the TTL the sweeper removes the tombstones. The FS store's mtimes are real,
	// so move the clock past them.
	h.now = time.Now().Add(169 * time.Hour)
	if err := h.srv.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	objs, _ = h.st.List(context.Background(), h.srv.keys.session("anonymous", proj, sess))
	if len(objs) != 0 {
		t.Fatalf("left after sweep: %v", objs)
	}
}

// MUN-51: a replay older than its project's retention is removed as a whole.
func TestRetentionSweep(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.Retention.PerProject = map[string]time.Duration{"forever": 0}
	})
	h.mustStore(chunk(strm, 0, "rrweb/2", "gzip", gz("a")))
	if _, _, msg := h.send(request("forever", scopeReplay, chunk(strm, 0, "rrweb/2", "gzip", gz("a")))); msg != "" {
		t.Fatal(msg)
	}
	h.now = time.Now().Add(719 * time.Hour)
	_ = h.srv.Sweep(context.Background())
	if code, _ := h.manifest(rep); code != 200 {
		t.Fatal("swept before retention")
	}
	h.now = time.Now().Add(721 * time.Hour)
	if err := h.srv.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if code, _ := h.manifest(rep); code != 404 {
		t.Fatalf("not swept: %d", code)
	}
	tomb, err := h.st.Get(context.Background(), h.srv.keys.tombstone("anonymous", proj, sess, rep))
	if err != nil || !strings.Contains(string(tomb), `"retention"`) {
		t.Fatalf("tombstone %s %v", tomb, err)
	}
	if w := h.get(fmt.Sprintf("/api/v1/projects/forever/sessions/%s/replays/%s", sess, rep)); w.Code != 200 {
		t.Fatalf("retention 0 swept: %d", w.Code)
	}
}

func TestRetentionTags(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.Retention.PerProject = map[string]time.Duration{"keep": 0, "short": 36 * time.Hour}
	})
	for p, want := range map[string]string{proj: "37d", "keep": "keep", "short": "9d"} {
		if got := h.srv.retentionTags(p)["ouo-retention"]; got != want {
			t.Errorf("%s: %s, want %s", p, got, want)
		}
	}
}

// Section 4 headers and limits.
func TestIngestHTTP(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.MultitenancyEnabled = true; c.Limits.MaxRequestBytes = 4096 })
	body := request(proj, scopeReplay, chunk(strm, 0, "rrweb/2", "gzip", gz("a")))
	tenant := map[string]string{"X-Scope-OrgID": "acme"}
	cases := []struct {
		name string
		hdr  map[string]string
		body []byte
		want int
	}{
		{"ok", tenant, body, 200},
		{"no token", map[string]string{"Authorization": "", "X-Scope-OrgID": "acme"}, body, 401},
		{"wrong token", map[string]string{"Authorization": "Bearer nope", "X-Scope-OrgID": "acme"}, body, 401},
		{"no tenant", nil, body, 401},
		{"bad tenant", map[string]string{"X-Scope-OrgID": "../x"}, body, 400},
		{"json", map[string]string{"X-Scope-OrgID": "acme", "Content-Type": "application/json"}, body, 415},
		{"brotli", map[string]string{"X-Scope-OrgID": "acme", "Content-Encoding": "br"}, body, 415},
		{"garbage", tenant, []byte("not protobuf \xff\xff\xff"), 400},
		{"too large", tenant, make([]byte, 5000), 413},
		{"gzip", map[string]string{"X-Scope-OrgID": "acme", "Content-Encoding": "gzip"}, gz(string(body)), 200},
		{"gzip bomb", map[string]string{"X-Scope-OrgID": "acme", "Content-Encoding": "gzip"}, gz(strings.Repeat("a", 10000)), 413},
	}
	for _, c := range cases {
		if code, _, msg := h.send(c.body, c.hdr); code != c.want {
			t.Errorf("%s: %d (%s), want %d", c.name, code, msg, c.want)
		}
	}
	// MUN-53: another tenant does not see it; another project does not either.
	if w := h.get(chunkPath(strm, 0), map[string]string{"X-Scope-OrgID": "acme"}); w.Code != 200 {
		t.Fatalf("own tenant %d", w.Code)
	}
	if w := h.get(chunkPath(strm, 0), map[string]string{"X-Scope-OrgID": "other"}); w.Code != 404 {
		t.Fatalf("other tenant %d", w.Code)
	}
	if w := h.get(strings.Replace(chunkPath(strm, 0), proj, "other", 1), map[string]string{"X-Scope-OrgID": "acme"}); w.Code != 404 {
		t.Fatalf("other project %d", w.Code)
	}
	if w := h.get(chunkPath(strm, 0), map[string]string{"X-Scope-OrgID": "acme", "Authorization": "Bearer it"}); w.Code != 401 {
		t.Fatalf("ingest token on read %d", w.Code)
	}
	if w := h.get("/api/v1/projects/shop-web/sessions/nothex/replays", map[string]string{"X-Scope-OrgID": "acme"}); w.Code != 400 {
		t.Fatalf("bad session id %d", w.Code)
	}
	if w := h.get(fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays", proj, strings.Repeat("e", 32)), map[string]string{"X-Scope-OrgID": "acme"}); w.Code != 200 || !strings.Contains(w.Body.String(), `"replays":[]`) {
		t.Fatalf("empty session %d %s", w.Code, w.Body.String())
	}
}

// failing makes every write fail, or panics.
type failing struct {
	store.Store
	panic bool
}

func (f failing) Create(ctx context.Context, k string, b []byte, t map[string]string) error {
	if f.panic {
		panic("boom")
	}
	return errors.New("store down")
}

// MUN-9, MUN-17: a store failure or an internal error answers 503 with Retry-After,
// and the retry stores the chunk once.
func TestTransientFailures(t *testing.T) {
	fs, _ := store.NewFS(t.TempDir())
	body := request(proj, scopeReplay, chunk(strm, 0, "rrweb/2", "gzip", gz("a")))
	for _, p := range []bool{false, true} {
		cfg := config.Defaults()
		h := newHarnessStore(t, cfg, failing{Store: fs, panic: p})
		w := h.do("POST", "/otlp/v1/logs", body, map[string]string{"Content-Type": "application/x-protobuf"})
		if w.Code != 503 || w.Header().Get("Retry-After") == "" {
			t.Fatalf("panic=%v: %d %q", p, w.Code, w.Header().Get("Retry-After"))
		}
	}
	h := newHarnessStore(t, config.Defaults(), fs)
	if w := h.do("POST", "/otlp/v1/logs", body, map[string]string{"Content-Type": "application/x-protobuf"}); w.Code != 200 {
		t.Fatalf("retry %d", w.Code)
	}
	objs, _ := fs.List(context.Background(), "muninn/anonymous/")
	if len(objs) != 1 {
		t.Fatalf("objects %v", objs)
	}
}

func TestSchemaRefusesNewerLayout(t *testing.T) {
	fs, _ := store.NewFS(t.TempDir())
	_ = fs.Put(context.Background(), "muninn/schema.json", []byte(`{"layout_version":2}`))
	if err := New(config.Defaults(), fs, "t").Init(context.Background()); err == nil {
		t.Fatal("started on a newer layout")
	}
}

func TestReadGzip(t *testing.T) {
	h := newHarness(t)
	h.mustStore(chunk(strm, 0, "rrweb/2", "gzip", gz("a")))
	w := h.get(fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays/%s", proj, sess, rep), map[string]string{"Accept-Encoding": "gzip"})
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("manifest not gzipped")
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(zr)
	if !strings.Contains(string(b), `"chunk_count":1`) {
		t.Fatal(string(b))
	}
}

// A stored object that cannot be decoded is skipped on reads (the rest of the session
// stays readable) and turns a repeat of that chunk into a rejection, never a 503 the
// Collector would retry for ever.
func TestCorruptObject(t *testing.T) {
	h := newHarness(t)
	h.mustStore(chunk(strm, 0, "rrweb/2", "gzip", gz("a")), chunk(strm, 1, "rrweb/2", "gzip", gz("b")))
	ctx := context.Background()
	k := h.srv.keys.chunk("anonymous", proj, sess, rep, strm, 1)
	_ = h.st.Delete(ctx, k)
	_ = h.st.Create(ctx, k, []byte("garbage"), nil)
	h.srv.headers = map[string]header{}
	_ = h.st.Create(ctx, h.srv.keys.ended("anonymous", proj, sess, rep, strm2), []byte("{not json"), nil)
	code, ri := h.manifest(rep)
	if code != 200 || ri.ChunkCount != 1 {
		t.Fatalf("manifest %d, %d chunks", code, ri.ChunkCount)
	}
	if w := h.get(fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays", proj, sess)); w.Code != 200 {
		t.Fatalf("list %d", w.Code)
	}
	code, rej, msg := h.send(request(proj, scopeReplay, chunk(strm, 1, "rrweb/2", "gzip", gz("b"))))
	if code != 200 || rej != 1 || !strings.HasPrefix(msg, "conflict:") {
		t.Fatalf("repeat over a corrupt object: %d %d %q", code, rej, msg)
	}
}
