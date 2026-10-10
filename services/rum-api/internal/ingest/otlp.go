package ingest

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	collogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	colmetrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// ProjectIDAttribute is the resource attribute rum-api stamps on every
// resource of every forwarded payload (ADR-0007 check 6).
const ProjectIDAttribute = "ouo.project.id"

// Signals rum-api accepts on /ingest/otlp/v1/<signal>.
const (
	SignalTraces  = "traces"
	SignalLogs    = "logs"
	SignalMetrics = "metrics"
	SignalReplay  = "replay" // not OTLP; used for the metrics attribute only
)

// newRequest returns the empty OTLP export request message of a signal.
func newRequest(signal string) (proto.Message, error) {
	switch signal {
	case SignalTraces:
		return &coltrace.ExportTraceServiceRequest{}, nil
	case SignalLogs:
		return &collogs.ExportLogsServiceRequest{}, nil
	case SignalMetrics:
		return &colmetrics.ExportMetricsServiceRequest{}, nil
	}
	return nil, fmt.Errorf("unknown signal %q", signal)
}

// Content types of an OTLP/HTTP request.
const (
	contentTypeProtobuf = "application/x-protobuf"
	contentTypeJSON     = "application/json"
)

var errUnsupportedContentType = errors.New("unsupported content type: use application/x-protobuf or application/json")

// decode parses body as the export request of signal, in protobuf or
// OTLP/JSON according to contentType (the media type without parameters).
func decode(signal, contentType string, body []byte) (proto.Message, error) {
	msg, err := newRequest(signal)
	if err != nil {
		return nil, err
	}
	switch contentType {
	case contentTypeProtobuf, "application/protobuf":
		if err := proto.Unmarshal(body, msg); err != nil {
			return nil, fmt.Errorf("invalid protobuf: %w", err)
		}
	case contentTypeJSON:
		fixed, err := normalizeOTLPJSON(body)
		if err != nil {
			return nil, fmt.Errorf("invalid json: %w", err)
		}
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(fixed, msg); err != nil {
			return nil, fmt.Errorf("invalid otlp json: %w", err)
		}
	default:
		return nil, errUnsupportedContentType
	}
	return msg, nil
}

// encode serializes the request as protobuf for the collector.
func encode(msg proto.Message) ([]byte, error) {
	return proto.MarshalOptions{Deterministic: true}.Marshal(msg)
}

// stamp sets ouo.project.id on every resource of the request (creating
// missing resources), overwriting whatever the client sent. It returns the
// number of resources touched.
func stamp(msg proto.Message, projectID string) int {
	n := 0
	switch m := msg.(type) {
	case *coltrace.ExportTraceServiceRequest:
		for _, rs := range m.ResourceSpans {
			rs.Resource = stampResource(rs.Resource, projectID)
			n++
		}
	case *collogs.ExportLogsServiceRequest:
		for _, rl := range m.ResourceLogs {
			rl.Resource = stampResource(rl.Resource, projectID)
			n++
		}
	case *colmetrics.ExportMetricsServiceRequest:
		for _, rm := range m.ResourceMetrics {
			rm.Resource = stampResource(rm.Resource, projectID)
			n++
		}
	}
	return n
}

func stampResource(res *resourcepb.Resource, projectID string) *resourcepb.Resource {
	if res == nil {
		res = &resourcepb.Resource{}
	}
	kept := res.Attributes[:0]
	for _, kv := range res.Attributes {
		if kv.GetKey() != ProjectIDAttribute {
			kept = append(kept, kv)
		}
	}
	res.Attributes = append(kept, &commonpb.KeyValue{
		Key:   ProjectIDAttribute,
		Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: projectID}},
	})
	return res
}

// idKeys are the bytes fields that OTLP/JSON encodes as hex (the OTLP spec
// deviates from protojson here, which expects base64 for bytes). Every other
// bytes field (AnyValue.bytes_value) is base64 as protojson expects.
var idKeys = map[string]int{
	"traceId": 32, "trace_id": 32,
	"spanId": 16, "span_id": 16,
	"parentSpanId": 16, "parent_span_id": 16,
}

// normalizeOTLPJSON rewrites hex trace / span ids to base64 so that
// protojson decodes them into the right bytes. Numbers are kept verbatim
// (json.Number) so 64-bit nanosecond timestamps do not lose precision. A
// value that is not hex of the expected length is left alone (it is either
// already base64 or invalid, and protojson decides).
func normalizeOTLPJSON(body []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, errors.New("trailing data after json object")
	}
	if _, ok := v.(map[string]any); !ok {
		return nil, errors.New("body must be a json object")
	}
	rewriteIDs(v)
	return json.Marshal(v)
}

func rewriteIDs(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			if want, isID := idKeys[k]; isID {
				if s, ok := child.(string); ok && len(s) == want && isHex(s) {
					raw, err := hex.DecodeString(s)
					if err == nil {
						t[k] = base64.StdEncoding.EncodeToString(raw)
					}
				}
				continue
			}
			rewriteIDs(child)
		}
	case []any:
		for _, child := range t {
			rewriteIDs(child)
		}
	}
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}
