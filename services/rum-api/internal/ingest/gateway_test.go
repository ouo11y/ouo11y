package ingest

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	collogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	rpcstatus "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/project"
)

const (
	demoToken  = "pt_dev_demo_0000000000000000"
	smallToken = "pt_small"
)

// fakeCollector records every request it gets and answers with a
// configurable status / body.
type fakeCollector struct {
	*httptest.Server
	mu       sync.Mutex
	requests []collectorRequest
	status   int
	body     []byte
	ct       string
}

type collectorRequest struct {
	path, contentType string
	body              []byte
}

func newFakeCollector(t *testing.T) *fakeCollector {
	fc := &fakeCollector{status: 200}
	fc.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		fc.mu.Lock()
		fc.requests = append(fc.requests, collectorRequest{path: r.URL.Path, contentType: r.Header.Get("Content-Type"), body: b})
		status, body, ct := fc.status, fc.body, fc.ct
		fc.mu.Unlock()
		if ct == "" {
			ct = contentTypeProtobuf
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(status)
		w.Write(body)
	}))
	t.Cleanup(fc.Close)
	return fc
}

func (fc *fakeCollector) last(t *testing.T) collectorRequest {
	t.Helper()
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if len(fc.requests) == 0 {
		t.Fatal("collector got nothing")
	}
	return fc.requests[len(fc.requests)-1]
}

func (fc *fakeCollector) count() int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return len(fc.requests)
}

func (fc *fakeCollector) respond(status int, ct string, body []byte) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.status, fc.ct, fc.body = status, ct, body
}

type env struct {
	gw        *Gateway
	srv       *httptest.Server
	collector *fakeCollector
	clock     *clock
	reader    *sdkmetric.ManualReader
}

func newEnv(t *testing.T, mod func(*Options)) *env {
	t.Helper()
	reg, err := project.New([]*project.Project{
		{ID: "demo", Tokens: []string{demoToken}, AllowedOrigins: []string{"http://localhost:*", "https://*.preview.example.com"}},
		{ID: "small", Tokens: []string{smallToken}, MaxBodyBytes: 200, RateLimit: &project.RateLimit{RequestsPerSecond: 1, Burst: 2}},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := newClock()
	fc := newFakeCollector(t)
	reader := sdkmetric.NewManualReader()
	opts := Options{
		Registry:          reg,
		CollectorEndpoint: fc.URL,
		MaxBodyBytes:      1 << 20,
		Now:               c.now,
		MeterProvider:     sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)),
	}
	if mod != nil {
		mod(&opts)
	}
	gw, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, s := range []string{SignalTraces, SignalLogs, SignalMetrics} {
		mux.Handle("POST /ingest/otlp/v1/"+s, gw.Handler(s))
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &env{gw: gw, srv: srv, collector: fc, clock: c, reader: reader}
}

type reqOpt func(*http.Request)

func withToken(tok string) reqOpt   { return func(r *http.Request) { r.Header.Set(TokenHeader, tok) } }
func withOrigin(o string) reqOpt    { return func(r *http.Request) { r.Header.Set("Origin", o) } }
func withHeader(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }
func gzipped() reqOpt {
	return func(r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		gw.Write(raw)
		gw.Close()
		r.Body = io.NopCloser(&buf)
		r.ContentLength = int64(buf.Len())
		r.Header.Set("Content-Encoding", "gzip")
	}
}

func (e *env) post(t *testing.T, signal, contentType string, body []byte, opts ...reqOpt) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/ingest/otlp/v1/"+signal, bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	for _, o := range opts {
		o(req)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

const (
	traceIDHex = "10398504df131ef48188906b1d611cc8"
	spanIDHex  = "8188906b1d611cc8"
)

func attr(k, v string) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: k, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: v}}}
}

// two resources: one with a client-set ouo.project.id (must be overwritten),
// one without any resource at all (must be created).
func traceRequest() *coltrace.ExportTraceServiceRequest {
	tid, _ := hex.DecodeString(traceIDHex)
	sid, _ := hex.DecodeString(spanIDHex)
	return &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{
			Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{attr("service.name", "web-store"), attr(ProjectIDAttribute, "liar")}},
			ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{{
				TraceId: tid, SpanId: sid, Name: "GET /", Kind: tracepb.Span_SPAN_KIND_CLIENT,
				StartTimeUnixNano: 1791263180896000000, EndTimeUnixNano: 1791263180902000000,
			}}}},
		},
		{ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{{TraceId: tid, SpanId: sid, Name: "orphan"}}}}},
	}}
}

func logsRequest() *collogs.ExportLogsServiceRequest {
	tid, _ := hex.DecodeString(traceIDHex)
	return &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{
		{Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{attr("service.name", "web-store"), attr(ProjectIDAttribute, "liar")}},
			ScopeLogs: []*logspb.ScopeLogs{{LogRecords: []*logspb.LogRecord{{TraceId: tid, Body: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: "session.start"}}}}}}},
		{ScopeLogs: []*logspb.ScopeLogs{{LogRecords: []*logspb.LogRecord{{SeverityText: "INFO"}}}}},
	}}
}

func metricsRequest() *colmetrics.ExportMetricsServiceRequest {
	return &colmetrics.ExportMetricsServiceRequest{ResourceMetrics: []*metricspb.ResourceMetrics{
		{Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{attr("service.name", "web-store"), attr(ProjectIDAttribute, "liar")}},
			ScopeMetrics: []*metricspb.ScopeMetrics{{Metrics: []*metricspb.Metric{{Name: "web_vital.lcp", Data: &metricspb.Metric_Gauge{Gauge: &metricspb.Gauge{DataPoints: []*metricspb.NumberDataPoint{{Value: &metricspb.NumberDataPoint_AsDouble{AsDouble: 1.5}}}}}}}}}},
		{ScopeMetrics: []*metricspb.ScopeMetrics{{Metrics: []*metricspb.Metric{{Name: "empty"}}}}},
	}}
}

func requestFor(signal string) proto.Message {
	switch signal {
	case SignalTraces:
		return traceRequest()
	case SignalLogs:
		return logsRequest()
	default:
		return metricsRequest()
	}
}

// resourcesOf decodes the protobuf the collector received and returns its resources.
func resourcesOf(t *testing.T, signal string, body []byte) []*resourcepb.Resource {
	t.Helper()
	var out []*resourcepb.Resource
	switch signal {
	case SignalTraces:
		var m coltrace.ExportTraceServiceRequest
		if err := proto.Unmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		for _, rs := range m.ResourceSpans {
			out = append(out, rs.Resource)
		}
	case SignalLogs:
		var m collogs.ExportLogsServiceRequest
		if err := proto.Unmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		for _, rl := range m.ResourceLogs {
			out = append(out, rl.Resource)
		}
	case SignalMetrics:
		var m colmetrics.ExportMetricsServiceRequest
		if err := proto.Unmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		for _, rm := range m.ResourceMetrics {
			out = append(out, rm.Resource)
		}
	}
	return out
}

func assertStamped(t *testing.T, resources []*resourcepb.Resource, want string) {
	t.Helper()
	if len(resources) != 2 {
		t.Fatalf("resources: %d", len(resources))
	}
	for i, res := range resources {
		if res == nil {
			t.Fatalf("resource %d is nil", i)
		}
		n := 0
		for _, kv := range res.Attributes {
			if kv.Key == ProjectIDAttribute {
				n++
				if kv.Value.GetStringValue() != want {
					t.Fatalf("resource %d: %s = %q", i, ProjectIDAttribute, kv.Value.GetStringValue())
				}
			}
		}
		if n != 1 {
			t.Fatalf("resource %d: %d project id attributes: %v", i, n, res.Attributes)
		}
	}
	if resources[0].Attributes[0].Key != "service.name" || resources[0].Attributes[0].Value.GetStringValue() != "web-store" {
		t.Fatalf("other attributes lost: %v", resources[0].Attributes)
	}
}

func TestStampAllSignalsProtobufAndJSON(t *testing.T) {
	e := newEnv(t, nil)
	for _, signal := range []string{SignalTraces, SignalLogs, SignalMetrics} {
		msg := requestFor(signal)
		pb, _ := proto.Marshal(msg)
		js, _ := protojson.Marshal(msg) // base64 ids, as protojson writes them
		for _, tc := range []struct {
			name, ct string
			body     []byte
			opts     []reqOpt
		}{
			{"proto", contentTypeProtobuf, pb, nil},
			{"proto+gzip", contentTypeProtobuf, pb, []reqOpt{gzipped()}},
			{"json", contentTypeJSON, js, nil},
			{"json+gzip", "application/json; charset=utf-8", js, []reqOpt{gzipped()}},
		} {
			resp, body := e.post(t, signal, tc.ct, tc.body, append(tc.opts, withToken(demoToken), withOrigin("http://localhost:5173"))...)
			if resp.StatusCode != 200 {
				t.Fatalf("%s %s: %d %s", signal, tc.name, resp.StatusCode, body)
			}
			got := e.collector.last(t)
			if got.path != "/v1/"+signal || got.contentType != contentTypeProtobuf {
				t.Fatalf("%s %s: forwarded to %s as %s", signal, tc.name, got.path, got.contentType)
			}
			assertStamped(t, resourcesOf(t, signal, got.body), "demo")
			// The response matches the client's encoding: an empty protobuf
			// Export*Response for protobuf clients, "{}" for JSON clients.
			if tc.ct == contentTypeProtobuf {
				if len(body) != 0 {
					t.Fatalf("%s %s: proto response body %q", signal, tc.name, body)
				}
			} else if resp.Header.Get("Content-Type") != contentTypeJSON || strings.TrimSpace(string(body)) != "{}" {
				t.Fatalf("%s %s: json response %s %q", signal, tc.name, resp.Header.Get("Content-Type"), body)
			}
		}
	}
	if n := e.collector.count(); n != 12 {
		t.Fatalf("collector requests: %d", n)
	}
}

// OTLP/JSON as the JS SDK writes it: hex ids, 64-bit numbers as strings,
// enums as numbers, camelCase keys. The hex ids must become the right bytes
// (protojson alone would base64-decode the hex string into 24 garbage bytes).
const jsSDKTrace = `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"web-store"}},{"key":"ouo.project.id","value":{"stringValue":"liar"}}]},
 "scopeSpans":[{"scope":{"name":"@opentelemetry/instrumentation-fetch","version":"0.50.0"},"spans":[
  {"traceId":"10398504df131ef48188906b1d611cc8","spanId":"8188906b1d611cc8","parentSpanId":"","name":"HTTP GET","kind":3,
   "startTimeUnixNano":"1791263180896000000","endTimeUnixNano":"1791263180902000123",
   "attributes":[{"key":"http.status_code","value":{"intValue":"200"}},{"key":"session.id","value":{"stringValue":"a4d47dfa"}}],
   "links":[{"traceId":"10398504df131ef48188906b1d611cc8","spanId":"0000000000000001"}],
   "status":{"code":2,"message":"boom"},"droppedAttributesCount":0,"unknownFutureField":{"x":1}}]}]},
 {"scopeSpans":[{"spans":[{"traceId":"10398504df131ef48188906b1d611cc8","spanId":"0000000000000002","name":"orphan","kind":1}]}]}]}`

func TestJSONHexIDsAndBigNumbers(t *testing.T) {
	e := newEnv(t, nil)
	resp, body := e.post(t, SignalTraces, contentTypeJSON, []byte(jsSDKTrace), withToken(demoToken))
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	var m coltrace.ExportTraceServiceRequest
	if err := proto.Unmarshal(e.collector.last(t).body, &m); err != nil {
		t.Fatal(err)
	}
	assertStamped(t, resourcesOf(t, SignalTraces, e.collector.last(t).body), "demo")
	sp := m.ResourceSpans[0].ScopeSpans[0].Spans[0]
	if hex.EncodeToString(sp.TraceId) != traceIDHex || hex.EncodeToString(sp.SpanId) != spanIDHex || len(sp.ParentSpanId) != 0 {
		t.Fatalf("ids: trace=%x span=%x parent=%x", sp.TraceId, sp.SpanId, sp.ParentSpanId)
	}
	if sp.EndTimeUnixNano != 1791263180902000123 || sp.StartTimeUnixNano != 1791263180896000000 {
		t.Fatalf("timestamps lost precision: %d %d", sp.StartTimeUnixNano, sp.EndTimeUnixNano)
	}
	if sp.Kind != tracepb.Span_SPAN_KIND_CLIENT || sp.Status.GetCode() != tracepb.Status_STATUS_CODE_ERROR || sp.Attributes[0].Value.GetIntValue() != 200 {
		t.Fatalf("enum / int: %v %v %v", sp.Kind, sp.Status, sp.Attributes)
	}
	if hex.EncodeToString(sp.Links[0].SpanId) != "0000000000000001" {
		t.Fatalf("link span id %x", sp.Links[0].SpanId)
	}
	if m.ResourceSpans[0].ScopeSpans[0].Scope.GetName() != "@opentelemetry/instrumentation-fetch" {
		t.Fatalf("scope lost: %v", m.ResourceSpans[0].ScopeSpans[0].Scope)
	}
}

func TestRejectionsInOrder(t *testing.T) {
	e := newEnv(t, nil)
	pb, _ := proto.Marshal(traceRequest())
	expect := func(name string, resp *http.Response, body []byte, want int) {
		t.Helper()
		if resp.StatusCode != want {
			t.Fatalf("%s: %d %s", name, resp.StatusCode, body)
		}
		var m map[string]string
		if want != 200 && (json.Unmarshal(body, &m) != nil || m["error"] == "") {
			t.Fatalf("%s: error body %q", name, body)
		}
	}
	big := bytes.Repeat([]byte("x"), (1<<20)+1)
	// 1. size beats token: oversized body with no token is 413, not 401.
	resp, body := e.post(t, SignalTraces, contentTypeProtobuf, big)
	expect("size before token", resp, body, 413)
	// Project override: `small` allows 200 bytes.
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, bytes.Repeat([]byte("x"), 201), withToken(smallToken))
	expect("project max_body_bytes", resp, body, 413)
	// Decompressed size counts too.
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, big, withToken(demoToken), gzipped())
	expect("gzip inflated size", resp, body, 413)
	// 2. token
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb)
	expect("missing token", resp, body, 401)
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken("pt_nope"))
	expect("unknown token", resp, body, 401)
	// Token beats origin: a bad origin with an unknown token is still 401.
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken("pt_nope"), withOrigin("https://evil.example"))
	expect("token before origin", resp, body, 401)
	// 3. origin
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken), withOrigin("https://evil.example"))
	expect("bad origin", resp, body, 403)
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken), withOrigin("null"))
	expect("null origin", resp, body, 403)
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken), withOrigin("https://pr-7.preview.example.com"))
	expect("wildcard origin", resp, body, 200)
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken)) // mobile / server: no Origin
	expect("no origin", resp, body, 200)
	// Origin beats decode: garbage from a bad origin is 403, not 400.
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, []byte("garbage"), withToken(demoToken), withOrigin("https://evil.example"))
	expect("origin before decode", resp, body, 403)
	// 5. decode
	before := e.collector.count()
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, []byte{0xff, 0xff, 0xff}, withToken(demoToken))
	expect("bad protobuf", resp, body, 400)
	resp, body = e.post(t, SignalTraces, contentTypeJSON, []byte(`{"resourceSpans": 5}`), withToken(demoToken))
	expect("bad json shape", resp, body, 400)
	resp, body = e.post(t, SignalTraces, contentTypeJSON, []byte(`[1,2]`), withToken(demoToken))
	expect("json array", resp, body, 400)
	resp, body = e.post(t, SignalTraces, contentTypeJSON, []byte(`{"a":1} trailing`), withToken(demoToken))
	expect("trailing json", resp, body, 400)
	resp, body = e.post(t, SignalTraces, "text/plain", pb, withToken(demoToken))
	expect("unsupported content type", resp, body, 400)
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, []byte("nope"), withToken(demoToken), withHeader("Content-Encoding", "gzip"))
	expect("bad gzip", resp, body, 400)
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken), withHeader("Content-Encoding", "br"))
	expect("unsupported encoding", resp, body, 400)
	if e.collector.count() != before {
		t.Fatal("rejected payloads reached the collector")
	}
	// Unknown fields are discarded (newer SDKs may send fields this proto
	// version lacks), so a trace payload on the logs route is an empty logs
	// export that is forwarded as such, not a 400.
	resp, body = e.post(t, SignalLogs, contentTypeJSON, []byte(jsSDKTrace), withToken(demoToken))
	expect("traces on the logs route", resp, body, 200)
	if got := e.collector.last(t); got.path != "/v1/logs" || len(got.body) != 0 {
		t.Fatalf("mis-routed payload: %s %d bytes", got.path, len(got.body))
	}
	// Empty body is a valid, empty export.
	resp, body = e.post(t, SignalMetrics, contentTypeProtobuf, nil, withToken(demoToken))
	expect("empty export", resp, body, 200)
}

func TestRateLimits(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.IPRateLimitRPS, o.IPRateLimitBurst = 1, 3 })
	small := []byte{} // empty export, within small's 200 bytes
	// Per-project bucket (small: 1 rps, burst 2).
	for i := 0; i < 2; i++ {
		if resp, body := e.post(t, SignalTraces, contentTypeProtobuf, small, withToken(smallToken)); resp.StatusCode != 200 {
			t.Fatalf("small %d: %d %s", i, resp.StatusCode, body)
		}
	}
	resp, body := e.post(t, SignalTraces, contentTypeProtobuf, small, withToken(smallToken))
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") != "1" {
		t.Fatalf("project limit: %d %q %s", resp.StatusCode, resp.Header.Get("Retry-After"), body)
	}
	e.clock.advance(time.Second)
	if resp, _ := e.post(t, SignalTraces, contentTypeProtobuf, small, withToken(smallToken)); resp.StatusCode != 200 {
		t.Fatalf("project limit after refill: %d", resp.StatusCode)
	}
	// Per-IP bucket (burst 3): demo has the default project limits, so the
	// IP bucket is what trips. The httptest client always comes from 127.0.0.1,
	// which has already spent 4 tokens above (project rejections do not spend).
	e.clock.advance(time.Hour)
	for i := 0; i < 3; i++ {
		if resp, body := e.post(t, SignalTraces, contentTypeProtobuf, small, withToken(demoToken)); resp.StatusCode != 200 {
			t.Fatalf("ip %d: %d %s", i, resp.StatusCode, body)
		}
	}
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, small, withToken(demoToken))
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("ip limit: %d %s", resp.StatusCode, body)
	}
	// A 429 does not reach the collector, and X-Forwarded-For is ignored
	// without OUO_TRUST_PROXY.
	n := e.collector.count()
	resp, _ = e.post(t, SignalTraces, contentTypeProtobuf, small, withToken(demoToken), withHeader("X-Forwarded-For", "10.0.0.1"))
	if resp.StatusCode != 429 || e.collector.count() != n {
		t.Fatalf("xff without trust: %d", resp.StatusCode)
	}
}

func TestTrustProxyUsesLastForwardedHop(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.TrustProxy = true; o.IPRateLimitRPS, o.IPRateLimitBurst = 1, 1 })
	for i, xff := range []string{"1.1.1.1", "9.9.9.9, 2.2.2.2", "3.3.3.3"} {
		if resp, _ := e.post(t, SignalTraces, contentTypeProtobuf, nil, withToken(demoToken), withHeader("X-Forwarded-For", xff)); resp.StatusCode != 200 {
			t.Fatalf("hop %d: %d", i, resp.StatusCode)
		}
	}
	// Same last hop as the second request: its bucket is empty.
	if resp, _ := e.post(t, SignalTraces, contentTypeProtobuf, nil, withToken(demoToken), withHeader("X-Forwarded-For", "8.8.8.8, 2.2.2.2")); resp.StatusCode != 429 {
		t.Fatalf("same last hop: %d", resp.StatusCode)
	}
	// A spoofed first hop does not help.
	if resp, _ := e.post(t, SignalTraces, contentTypeProtobuf, nil, withToken(demoToken), withHeader("X-Forwarded-For", "2.2.2.2, 7.7.7.7")); resp.StatusCode != 200 {
		t.Fatalf("different last hop: %d", resp.StatusCode)
	}
}

func TestCollectorErrorsArePassedBack(t *testing.T) {
	e := newEnv(t, nil)
	pb, _ := proto.Marshal(traceRequest())
	// Collector says 503 with an rpc Status: proto clients get it verbatim,
	// JSON clients get it as JSON.
	st, _ := proto.Marshal(&rpcstatus.Status{Code: 14, Message: "queue full"})
	e.collector.respond(503, contentTypeProtobuf, st)
	resp, body := e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken))
	if resp.StatusCode != 503 || !bytes.Equal(body, st) || resp.Header.Get("Content-Type") != contentTypeProtobuf {
		t.Fatalf("proto passthrough: %d %s %q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	resp, body = e.post(t, SignalTraces, contentTypeJSON, []byte(jsSDKTrace), withToken(demoToken))
	if resp.StatusCode != 503 || resp.Header.Get("Content-Type") != contentTypeJSON || !strings.Contains(string(body), "queue full") {
		t.Fatalf("json passthrough: %d %s %q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	// Partial success on 200 is transcoded too.
	ps, _ := proto.Marshal(&coltrace.ExportTraceServiceResponse{PartialSuccess: &coltrace.ExportTracePartialSuccess{RejectedSpans: 1, ErrorMessage: "dropped"}})
	e.collector.respond(200, contentTypeProtobuf, ps)
	resp, body = e.post(t, SignalTraces, contentTypeJSON, []byte(jsSDKTrace), withToken(demoToken))
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"rejectedSpans":"1"`) {
		t.Fatalf("partial success: %d %s", resp.StatusCode, body)
	}
	// A non-protobuf collector body is copied as is.
	e.collector.respond(400, "text/plain", []byte("nope"))
	resp, body = e.post(t, SignalTraces, contentTypeJSON, []byte(jsSDKTrace), withToken(demoToken))
	if resp.StatusCode != 400 || string(body) != "nope" || resp.Header.Get("Content-Type") != "text/plain" {
		t.Fatalf("text passthrough: %d %s %q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	// Unreachable collector: 502.
	e.collector.Close()
	resp, body = e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken))
	if resp.StatusCode != 502 {
		t.Fatalf("unreachable: %d %s", resp.StatusCode, body)
	}
}

func TestCollectorTimeout(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	defer slow.Close()
	e := newEnv(t, func(o *Options) { o.CollectorEndpoint = slow.URL; o.CollectorTimeout = 50 * time.Millisecond })
	start := time.Now()
	resp, _ := e.post(t, SignalTraces, contentTypeProtobuf, nil, withToken(demoToken))
	if resp.StatusCode != 502 || time.Since(start) > time.Second {
		t.Fatalf("timeout: %d after %v", resp.StatusCode, time.Since(start))
	}
}

func TestAuthorizeForReplay(t *testing.T) {
	e := newEnv(t, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/replay/chunks", strings.NewReader("{}"))
	if p := e.gw.Authorize(rec, req, SignalReplay, 100); p != nil || rec.Code != 401 {
		t.Fatalf("no token: %v %d", p, rec.Code)
	}
	rec = httptest.NewRecorder()
	req.Header.Set(TokenHeader, demoToken)
	req.Header.Set("Origin", "https://evil.example")
	if p := e.gw.Authorize(rec, req, SignalReplay, 100); p != nil || rec.Code != 403 {
		t.Fatalf("origin: %v %d", p, rec.Code)
	}
	rec = httptest.NewRecorder()
	req.Header.Set("Origin", "http://localhost:5173")
	req.ContentLength = 101
	if p := e.gw.Authorize(rec, req, SignalReplay, 100); p != nil || rec.Code != 413 {
		t.Fatalf("size: %v %d", p, rec.Code)
	}
	rec = httptest.NewRecorder()
	req.ContentLength = 2
	if p := e.gw.Authorize(rec, req, SignalReplay, 100); p == nil || p.ID != "demo" || rec.Code != 200 {
		t.Fatalf("ok: %v %d", p, rec.Code)
	}
	e.gw.RecordAccepted(context.Background(), "demo", SignalReplay, 2)
	e.gw.RecordRejected(context.Background(), "demo", SignalReplay, ReasonDecode)
}

func TestMetrics(t *testing.T) {
	e := newEnv(t, nil)
	pb, _ := proto.Marshal(traceRequest())
	e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken))
	e.post(t, SignalTraces, contentTypeProtobuf, pb, withToken(demoToken))
	e.post(t, SignalLogs, contentTypeProtobuf, pb)
	e.post(t, SignalLogs, contentTypeJSON, []byte("{"), withToken(demoToken))
	e.post(t, SignalMetrics, contentTypeProtobuf, pb, withToken(demoToken), withOrigin("https://evil.example"))
	e.gw.RecordAccepted(context.Background(), "demo", SignalReplay, 10)

	var rm metricdata.ResourceMetrics
	if err := e.reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	sums := map[string]map[string]int64{} // metric -> attribute set -> value
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				t.Fatalf("%s is %T", m.Name, m.Data)
			}
			if sums[m.Name] == nil {
				sums[m.Name] = map[string]int64{}
			}
			for _, dp := range sum.DataPoints {
				sums[m.Name][attrKey(dp.Attributes)] = dp.Value
			}
		}
	}
	want := map[string]map[string]int64{
		"ouo.ingest.requests": {
			"ouo.project.id=demo,signal=traces,outcome=ok":                      2,
			"ouo.project.id=,signal=logs,outcome=rejected,reason=token":         1,
			"ouo.project.id=demo,signal=logs,outcome=rejected,reason=decode":    1,
			"ouo.project.id=demo,signal=metrics,outcome=rejected,reason=origin": 1,
			"ouo.project.id=demo,signal=replay,outcome=ok":                      1,
		},
		"ouo.ingest.bytes":  {"ouo.project.id=demo,signal=traces": int64(2 * len(pb)), "ouo.project.id=demo,signal=replay": 10},
		"ouo.replay.chunks": {"ouo.project.id=demo": 1},
		"ouo.replay.bytes":  {"ouo.project.id=demo": 10},
	}
	for name, series := range want {
		for k, v := range series {
			if sums[name][k] != v {
				t.Errorf("%s{%s} = %d, want %d (all: %v)", name, k, sums[name][k], v, sums[name])
			}
		}
		if len(sums[name]) != len(series) {
			t.Errorf("%s: unexpected series %v", name, sums[name])
		}
	}
}

// attrKey renders an attribute set in the fixed order the gateway uses.
func attrKey(set attribute.Set) string {
	var parts []string
	for _, k := range []string{ProjectIDAttribute, "signal", "outcome", "reason"} {
		if v, ok := set.Value(attribute.Key(k)); ok {
			parts = append(parts, k+"="+v.AsString())
		}
	}
	return strings.Join(parts, ",")
}
