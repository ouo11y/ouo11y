package ouoratelimitprocessor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/confmap"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/extension/extensionmiddleware"
	"go.opentelemetry.io/collector/extension/extensiontest"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/processor/processortest"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor/internal/metadata"
)

// startPair starts an ouoratelimit processor (client burst 2) and the
// extension pointing at it.
func startPair(t *testing.T) (processor.Traces, *edgeLimiter, *consumertest.TracesSink) {
	t.Helper()
	cfg := createDefaultConfig().(*Config)
	cfg.Client.BucketConfig = BucketConfig{Rate: 1, Burst: 2}
	id := component.MustNewIDWithName("ouoratelimit", t.Name())
	set := processortest.NewNopSettings(metadata.Type)
	set.ID = id
	sink := new(consumertest.TracesSink)
	tp, err := NewFactory().CreateTraces(context.Background(), set, cfg, sink)
	if err != nil {
		t.Fatal(err)
	}
	if err := tp.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	f := NewExtensionFactory()
	ecfg := f.CreateDefaultConfig().(*ExtensionConfig)
	if err := confmap.NewFromStringMap(map[string]any{"processor": id.String()}).Unmarshal(ecfg); err != nil {
		t.Fatal(err)
	}
	ext, err := f.Create(context.Background(), extensiontest.NewNopSettings(metadata.Type), ecfg)
	if err != nil {
		t.Fatal(err)
	}
	return tp, ext.(*edgeLimiter), sink
}

func TestExtensionDefaultConfig(t *testing.T) {
	cfg := NewExtensionFactory().CreateDefaultConfig().(*ExtensionConfig)
	if cfg.Processor != component.NewID(metadata.Type) {
		t.Fatalf("default processor %v", cfg.Processor)
	}
}

func TestHTTPMiddlewareChargesEmptyRequests(t *testing.T) {
	tp, ext, sink := startPair(t)
	wrap, err := ext.GetHTTPHandler(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Stand-in for the OTLP receiver: the first request is an empty export (no
	// pipeline call, as upstream does), the second one reaches the processor.
	var calls int
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 2 {
			if err := tp.ConsumeTraces(r.Context(), ptrace.NewTraces()); err != nil {
				t.Errorf("charged request rejected by the processor: %v", err)
			}
		}
		w.WriteHeader(http.StatusOK)
	})
	h, err := wrap(context.Background(), inner)
	if err != nil {
		t.Fatal(err)
	}
	ctx := ctxFor("demo", "198.51.100.9", nil)
	got := []int{}
	var last *httptest.ResponseRecorder
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodPost, "/v1/traces", strings.NewReader(`{"resourceSpans":[]}`)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		last = httptest.NewRecorder()
		h.ServeHTTP(last, req)
		got = append(got, last.Code)
	}
	if got[0] != 200 || got[1] != 200 || got[2] != http.StatusTooManyRequests {
		t.Fatalf("codes %v, want 200 200 429", got)
	}
	if calls != 2 || len(sink.AllTraces()) != 1 {
		t.Fatalf("inner calls %d, sink %d", calls, len(sink.AllTraces()))
	}
	if ra := last.Header().Get("Retry-After"); ra != "1" {
		t.Fatalf("Retry-After %q", ra)
	}
	var body struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(last.Body.Bytes(), &body); err != nil || body.Code != int(codes.ResourceExhausted) || !strings.Contains(body.Message, "rate limit") {
		t.Fatalf("body %s (%v)", last.Body.String(), err)
	}
	// An uncharged request (another receiver, no middleware) is still limited by the processor.
	if err := tp.ConsumeTraces(ctx, ptrace.NewTraces()); err == nil {
		t.Fatal("processor let an uncharged request through an empty bucket")
	}
}

func TestHTTPMiddlewareWithoutProcessorPassesThrough(t *testing.T) {
	ext := &edgeLimiter{processor: component.MustNewIDWithName("ouoratelimit", "absent")}
	wrap, _ := ext.GetHTTPHandler(context.Background())
	h, _ := wrap(context.Background(), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/traces", nil))
	if rec.Code != 204 {
		t.Fatalf("code %d", rec.Code)
	}
}

func TestGRPCInterceptor(t *testing.T) {
	_, ext, _ := startPair(t)
	opts, err := ext.GetGRPCServerOptions(context.Background())
	if err != nil || len(opts) != 1 {
		t.Fatalf("opts %v %v", opts, err)
	}
	var got []bool
	handler := func(ctx context.Context, _ any) (any, error) { got = append(got, charged(ctx)); return nil, nil }
	icpt := ext.unary
	ctx := ctxFor("demo", "198.51.100.10", nil)
	for i := 0; i < 2; i++ {
		if _, err := icpt(ctx, nil, &grpc.UnaryServerInfo{}, handler); err != nil {
			t.Fatal(err)
		}
	}
	_, err = icpt(ctx, nil, &grpc.UnaryServerInfo{}, handler)
	if st, ok := status.FromError(err); !ok || st.Code() != codes.ResourceExhausted {
		t.Fatalf("third call: %v", err)
	}
	if len(got) != 2 || !got[0] || !got[1] {
		t.Fatalf("handler saw charged=%v", got)
	}
}

var _ extensionmiddleware.HTTPServer = (*edgeLimiter)(nil)
