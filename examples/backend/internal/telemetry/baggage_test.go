package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// newTestTracer returns a TracerProvider that records spans in memory and
// runs the baggage processor, mirroring the production wiring.
func newTestTracer(t *testing.T) (*sdktrace.TracerProvider, *tracetest.InMemoryExporter) {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(NewBaggageSpanProcessor()),
		sdktrace.WithSyncer(exp),
	)
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	return tp, exp
}

func attrValue(attrs []attribute.KeyValue, key string) (string, bool) {
	for _, kv := range attrs {
		if string(kv.Key) == key {
			return kv.Value.AsString(), true
		}
	}
	return "", false
}

func TestBaggageSessionIDIsCopiedToServerSpan(t *testing.T) {
	tp, exp := newTestTracer(t)

	var childEnded bool
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A child span must inherit the attributes too (it starts with the
		// same context, so baggage is still present).
		_, child := tp.Tracer("test").Start(r.Context(), "db.query")
		child.End()
		childEnded = true
		w.WriteHeader(http.StatusNoContent)
	})
	h := otelhttp.NewHandler(inner, "http.server",
		otelhttp.WithTracerProvider(tp),
		otelhttp.WithPropagators(NewPropagator()),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/products", nil)
	req.Header.Set("baggage", "session.id=abc,user.id=u-1,ouo.platform=web,unrelated=x")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !childEnded {
		t.Fatal("handler did not run")
	}
	spans := exp.GetSpans()
	if len(spans) != 2 {
		t.Fatalf("expected 2 spans (server + child), got %d", len(spans))
	}

	var server, child tracetest.SpanStub
	for _, s := range spans {
		switch s.SpanKind {
		case trace.SpanKindServer:
			server = s
		default:
			child = s
		}
	}
	if server.Name == "" {
		t.Fatal("no server span recorded")
	}

	for _, s := range []tracetest.SpanStub{server, child} {
		for k, want := range map[string]string{"session.id": "abc", "user.id": "u-1", "ouo.platform": "web"} {
			got, ok := attrValue(s.Attributes, k)
			if !ok || got != want {
				t.Errorf("span %q: attribute %s = %q (present=%v), want %q", s.Name, k, got, ok, want)
			}
		}
		if _, ok := attrValue(s.Attributes, "unrelated"); ok {
			t.Errorf("span %q: unrelated baggage member must not be copied", s.Name)
		}
	}
	if child.Parent.SpanID() != server.SpanContext.SpanID() {
		t.Errorf("child span is not parented to the server span")
	}
}

func TestNoBaggageAddsNoAttributes(t *testing.T) {
	tp, exp := newTestTracer(t)
	_, span := tp.Tracer("test").Start(context.Background(), "plain")
	span.End()

	spans := exp.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	for _, k := range BaggageKeys {
		if _, ok := attrValue(spans[0].Attributes, k); ok {
			t.Errorf("attribute %s must be absent without baggage", k)
		}
	}
}

func TestTraceparentJoinsIncomingTrace(t *testing.T) {
	tp, exp := newTestTracer(t)
	h := otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), "http.server", otelhttp.WithTracerProvider(tp), otelhttp.WithPropagators(NewPropagator()))

	const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("traceparent", "00-"+traceID+"-00f067aa0ba902b7-01")
	h.ServeHTTP(httptest.NewRecorder(), req)

	spans := exp.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	if got := spans[0].SpanContext.TraceID().String(); got != traceID {
		t.Errorf("trace id = %s, want %s (server span must join the client's trace)", got, traceID)
	}
	if got := spans[0].Parent.SpanID().String(); got != "00f067aa0ba902b7" {
		t.Errorf("parent span id = %s, want 00f067aa0ba902b7", got)
	}
}
