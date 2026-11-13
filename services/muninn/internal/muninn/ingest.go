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
	"log/slog"
	"math"
	"mime"
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	collogspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	"google.golang.org/protobuf/proto"

	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
)

const (
	scopeReplay = "ouo.replay"
	eventChunk  = "ouo.replay.chunk"
	eventEnded  = "ouo.replay.ended"
)

// Attributes that have a field of their own in the manifest (section 7.2).
var chunkFields = map[string]bool{
	"session.id": true, "ouo.replay.id": true, "ouo.replay.stream.id": true, "ouo.replay.sequence": true,
	"ouo.replay.segment.index": true, "ouo.replay.keyframe": true, "ouo.replay.start_time": true,
	"ouo.replay.end_time": true, "ouo.replay.format": true, "ouo.replay.encoding": true,
	"ouo.replay.byte_size": true, "ouo.replay.sha256": true,
}

// item is one valid record ready to store.
type item struct {
	event                            string
	project, session, replay, stream string
	seq                              int64
	sha, format                      string
	body                             []byte // chunk only
	attrs                            map[string]any
	timeUnixNano                     uint64
}

type rejection struct{ reason, detail string }

func (r *rejection) Error() string { return r.reason + ": " + r.detail }

func reject(reason, format string, a ...any) *rejection {
	return &rejection{reason: reason, detail: fmt.Sprintf(format, a...)}
}

func (s *Server) ingest(w http.ResponseWriter, r *http.Request) {
	start := s.now()
	status := http.StatusOK
	defer func() {
		s.m.ingestDuration.Record(r.Context(), time.Since(start).Seconds(),
			metric.WithAttributes(attribute.Int("http.response.status_code", status)))
	}()
	fail := func(code int, msg string) {
		status = code
		if code == http.StatusServiceUnavailable {
			w.Header().Set("Retry-After", "5")
		}
		http.Error(w, msg, code)
	}

	if !bearerOK(r, s.cfg.Auth.IngestToken) {
		fail(http.StatusUnauthorized, "unauthorized")
		return
	}
	tenant, code := s.tenant(r)
	if code != 0 {
		fail(code, "bad or missing X-Scope-OrgID")
		return
	}
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/x-protobuf" {
		fail(http.StatusUnsupportedMediaType, "Content-Type must be application/x-protobuf")
		return
	}
	limit := int64(s.cfg.Limits.MaxRequestBytes)
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		fail(http.StatusServiceUnavailable, "read body")
		return
	}
	if int64(len(raw)) > limit {
		fail(http.StatusRequestEntityTooLarge, "request too large")
		return
	}
	switch r.Header.Get("Content-Encoding") {
	case "", "identity":
	case "gzip":
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			fail(http.StatusBadRequest, "bad gzip body")
			return
		}
		raw, err = io.ReadAll(io.LimitReader(zr, limit+1))
		if err != nil {
			fail(http.StatusBadRequest, "bad gzip body")
			return
		}
		if int64(len(raw)) > limit {
			fail(http.StatusRequestEntityTooLarge, "request too large")
			return
		}
	default:
		fail(http.StatusUnsupportedMediaType, "unsupported Content-Encoding")
		return
	}
	var req collogspb.ExportLogsServiceRequest
	if err := proto.Unmarshal(raw, &req); err != nil {
		fail(http.StatusBadRequest, "body is not an OTLP logs request")
		return
	}

	ctx := r.Context()
	var items []item
	var rejected int64
	firstReason := ""
	for _, rl := range req.GetResourceLogs() {
		project, projectOK := stringAttr(rl.GetResource().GetAttributes(), "ouo.project.id")
		projectOK = projectOK && reProject.MatchString(project)
		for _, sl := range rl.GetScopeLogs() {
			for _, lr := range sl.GetLogRecords() {
				it, rej := s.validate(sl.GetScope().GetName(), project, projectOK, lr)
				if rej != nil {
					rejected++
					if firstReason == "" {
						firstReason = rej.Error()
					}
					s.count(ctx, project, lr.GetEventName(), "rejected", rej.reason, "")
					continue
				}
				items = append(items, it)
			}
		}
	}

	// Store every valid record; any transient failure answers 503 for the whole
	// request (MUN-17). Already stored records become no-ops on the retry (MUN-13).
	tomb := map[string]bool{}
	for _, it := range items {
		outcome, rej, err := s.store1(ctx, tenant, it, tomb)
		if err != nil {
			slog.WarnContext(ctx, "ingest store failure", "err", err)
			fail(http.StatusServiceUnavailable, "store unavailable")
			return
		}
		if rej != nil {
			rejected++
			if firstReason == "" {
				firstReason = rej.Error()
			}
			s.count(ctx, it.project, it.event, "rejected", rej.reason, it.format)
			continue
		}
		s.count(ctx, it.project, it.event, outcome, "", it.format)
		if outcome == "stored" && it.event == eventChunk {
			s.m.ingestBytes.Add(ctx, int64(len(it.body)), metric.WithAttributes(
				attribute.String("ouo.project.id", it.project), attribute.String("ouo.replay.format", it.format)))
		}
	}

	resp := &collogspb.ExportLogsServiceResponse{}
	if rejected > 0 {
		resp.PartialSuccess = &collogspb.ExportLogsPartialSuccess{RejectedLogRecords: rejected, ErrorMessage: firstReason}
	}
	out, _ := proto.Marshal(resp)
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func (s *Server) count(ctx context.Context, project, event, outcome, reason, format string) {
	s.m.records.Add(ctx, 1, metric.WithAttributes(
		attribute.String("ouo.project.id", project), attribute.String("event", event),
		attribute.String("outcome", outcome), attribute.String("reason", reason),
		attribute.String("ouo.replay.format", format)))
}

// store1 writes one record: "stored", "duplicate" or "tombstoned"; a rejection for
// a conflict (MUN-14); an error for a transient failure.
func (s *Server) store1(ctx context.Context, tenant string, it item, tomb map[string]bool) (string, *rejection, error) {
	tk := s.keys.tombstone(tenant, it.project, it.session, it.replay)
	dead, seen := tomb[tk]
	if !seen {
		_, err := s.store.GetRange(ctx, tk, 0, 1)
		switch {
		case err == nil:
			dead = true
		case errors.Is(err, store.ErrNotFound):
		default:
			return "", nil, err
		}
		tomb[tk] = dead
	}
	if dead {
		return "tombstoned", nil, nil // MUN-15
	}
	tags := s.retentionTags(it.project)
	rec := header{Attributes: it.attrs, TimeUnixNano: strconv.FormatUint(it.timeUnixNano, 10), ReceivedAt: s.now().UnixMilli(), Project: it.project}

	if it.event == eventEnded {
		b, _ := json.Marshal(rec)
		err := s.store.Create(ctx, s.keys.ended(tenant, it.project, it.session, it.replay, it.stream), b, tags)
		if errors.Is(err, store.ErrExists) {
			return "duplicate", nil, nil // MUN-8: the first one stays
		}
		if err != nil {
			return "", nil, err
		}
		return "stored", nil, nil
	}

	key := s.keys.chunk(tenant, it.project, it.session, it.replay, it.stream, it.seq)
	obj, err := encodeChunk(rec, it.body)
	if err != nil {
		return "", nil, err
	}
	err = s.store.Create(ctx, key, obj, tags)
	if err == nil {
		return "stored", nil, nil
	}
	if !errors.Is(err, store.ErrExists) {
		return "", nil, err
	}
	h, err := s.header(ctx, key)
	if err != nil {
		return "", nil, err
	}
	if attrString(h.Attributes, "ouo.replay.sha256") == it.sha {
		return "duplicate", nil, nil // MUN-13
	}
	return "", reject("conflict", "chunk %s/%d already stored with another hash", it.stream, it.seq), nil
}

// retentionTags: ouo-retention=<retention days + tombstone_ttl days>d, or keep (MUN-52).
func (s *Server) retentionTags(project string) map[string]string {
	ret := s.cfg.Retention.For(project)
	if ret <= 0 {
		return map[string]string{"ouo-retention": "keep"}
	}
	days := func(d time.Duration) int { return int(math.Ceil(d.Hours() / 24)) }
	return map[string]string{"ouo-retention": fmt.Sprintf("%dd", days(ret)+days(s.cfg.TombstoneTTL))}
}

// validate applies section 3 to one record (MUN-5, MUN-11, MUN-12).
func (s *Server) validate(scope, project string, projectOK bool, lr *logspb.LogRecord) (item, *rejection) {
	var it item
	if scope != scopeReplay {
		return it, reject("not_replay", "scope %q", scope)
	}
	if !projectOK {
		return it, reject("no_project", "resource has no valid ouo.project.id")
	}
	ev := lr.GetEventName()
	if ev != eventChunk && ev != eventEnded {
		return it, reject("unknown_event", "event %q", ev)
	}
	it.event, it.project, it.timeUnixNano = ev, project, lr.GetTimeUnixNano()

	size := 0
	a := make(map[string]*commonpb.AnyValue, len(lr.GetAttributes()))
	it.attrs = make(map[string]any, len(lr.GetAttributes()))
	for _, kv := range lr.GetAttributes() {
		size += proto.Size(kv)
		a[kv.GetKey()] = kv.GetValue()
		it.attrs[kv.GetKey()] = jsonValue(kv.GetValue())
	}
	if size > s.cfg.Limits.MaxAttributeBytes {
		return it, reject("bad_attribute", "attributes are %d bytes, limit %d", size, s.cfg.Limits.MaxAttributeBytes)
	}
	if _, ok := a["ouo.replay.ref"]; ok {
		return it, reject("bad_attribute", "ouo.replay.ref must be absent")
	}
	v := attrs{a: a}
	it.session = v.id("session.id")
	it.replay = v.id("ouo.replay.id")
	it.stream = v.id("ouo.replay.stream.id")

	if ev == eventEnded {
		state := v.str("ouo.replay.end_state")
		if v.err == nil && state != "complete" && state != "partial" {
			v.bad("ouo.replay.end_state %q", state)
		}
		v.str("ouo.replay.end_reason")
		if _, ok := a["ouo.replay.last_sequence"]; ok {
			v.seq("ouo.replay.last_sequence")
		}
		return it, v.err
	}

	it.seq = v.seq("ouo.replay.sequence")
	if seg := v.int("ouo.replay.segment.index"); v.err == nil && seg < 0 {
		v.bad("ouo.replay.segment.index %d < 0", seg)
	}
	v.bool("ouo.replay.keyframe")
	st, et := v.int("ouo.replay.start_time"), v.int("ouo.replay.end_time")
	if v.err == nil && st > et {
		v.bad("ouo.replay.start_time > end_time")
	}
	it.format = v.str("ouo.replay.format")
	if v.err == nil && !reFormat.MatchString(it.format) {
		v.bad("ouo.replay.format %q", it.format)
	}
	if enc := v.str("ouo.replay.encoding"); v.err == nil && enc != "gzip" && enc != "identity" {
		v.bad("ouo.replay.encoding %q", enc)
	}
	it.sha = v.str("ouo.replay.sha256")
	if v.err == nil && !reHex64.MatchString(it.sha) {
		v.bad("ouo.replay.sha256 is not 64 lowercase hex")
	}
	n := v.int("ouo.replay.byte_size")
	v.bool("ouo.replay.masked")
	mode := v.str("ouo.replay.mode")
	if v.err == nil && mode != "session" && mode != "buffer" {
		v.bad("ouo.replay.mode %q", mode)
	}
	if v.err == nil && mode == "buffer" {
		v.str("ouo.replay.trigger")
	}
	if v.err != nil {
		return it, v.err
	}

	body, ok := lr.GetBody().GetValue().(*commonpb.AnyValue_BytesValue)
	if !ok {
		return it, reject("bad_attribute", "body is not bytes")
	}
	it.body = body.BytesValue
	if len(it.body) > s.cfg.Limits.MaxChunkBytes || n > int64(s.cfg.Limits.MaxChunkBytes) {
		return it, reject("too_large", "chunk is %d bytes, limit %d", len(it.body), s.cfg.Limits.MaxChunkBytes)
	}
	if len(it.body) == 0 || n != int64(len(it.body)) {
		return it, reject("size_mismatch", "byte_size %d, body %d bytes", n, len(it.body))
	}
	sum := sha256.Sum256(it.body)
	if hex.EncodeToString(sum[:]) != it.sha {
		return it, reject("hash_mismatch", "sha256 does not match the body")
	}
	return it, nil
}

// attrs reads typed attributes and keeps the first error.
type attrs struct {
	a   map[string]*commonpb.AnyValue
	err *rejection
}

func (v *attrs) get(k string) *commonpb.AnyValue {
	if v.err != nil {
		return nil
	}
	x, ok := v.a[k]
	if !ok || x.GetValue() == nil {
		v.err = reject("missing_attribute", "%s", k)
		return nil
	}
	return x
}

func (v *attrs) bad(format string, a ...any) {
	if v.err == nil {
		v.err = reject("bad_attribute", format, a...)
	}
}

func (v *attrs) str(k string) string {
	x := v.get(k)
	if x == nil {
		return ""
	}
	s, ok := x.GetValue().(*commonpb.AnyValue_StringValue)
	if !ok {
		v.bad("%s is not a string", k)
		return ""
	}
	return s.StringValue
}

func (v *attrs) int(k string) int64 {
	x := v.get(k)
	if x == nil {
		return 0
	}
	switch n := x.GetValue().(type) {
	case *commonpb.AnyValue_IntValue:
		return n.IntValue
	case *commonpb.AnyValue_DoubleValue: // integral doubles from JSON-minded SDKs
		if n.DoubleValue == math.Trunc(n.DoubleValue) && math.Abs(n.DoubleValue) < 1<<53 {
			return int64(n.DoubleValue)
		}
	}
	v.bad("%s is not an integer", k)
	return 0
}

func (v *attrs) bool(k string) bool {
	x := v.get(k)
	if x == nil {
		return false
	}
	b, ok := x.GetValue().(*commonpb.AnyValue_BoolValue)
	if !ok {
		v.bad("%s is not a bool", k)
		return false
	}
	return b.BoolValue
}

func (v *attrs) id(k string) string {
	s := v.str(k)
	if v.err == nil && !reHex32.MatchString(s) {
		v.err = reject("bad_id", "%s is not 32 lowercase hex", k)
	}
	return s
}

func (v *attrs) seq(k string) int64 {
	n := v.int(k)
	if v.err == nil && (n < 0 || n > maxSequence) {
		v.err = reject("bad_id", "%s %d out of range", k, n)
	}
	return n
}

func stringAttr(kvs []*commonpb.KeyValue, k string) (string, bool) {
	for _, kv := range kvs {
		if kv.GetKey() == k {
			s, ok := kv.GetValue().GetValue().(*commonpb.AnyValue_StringValue)
			if ok {
				return s.StringValue, true
			}
			return "", false
		}
	}
	return "", false
}
