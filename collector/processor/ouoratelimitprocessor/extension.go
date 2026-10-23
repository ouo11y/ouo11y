package ouoratelimitprocessor // import "github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor"

import (
	"context"
	"mime"
	"net/http"
	"strconv"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/extension"
	"go.opentelemetry.io/collector/extension/extensionmiddleware"
	"go.opentelemetry.io/otel/metric"
	"go.uber.org/zap"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor/internal/metadata"
)

// ExtensionConfig configures the ouoratelimit extension: a receiver middleware
// (confighttp / configgrpc `middlewares`) that charges every authenticated
// request at the edge with the buckets of an ouoratelimit processor.
//
// The upstream OTLP receiver answers a request with no spans, records or
// data points 200 without calling the pipeline, so the processor never sees
// it; the middleware runs before that check. Requests it charged are marked
// in their context and the processor lets them through without taking a
// second token, so one request still costs one token.
type ExtensionConfig struct {
	// Processor is the ID of the ouoratelimit processor whose buckets (and
	// client.key_from) the middleware uses. Default `ouoratelimit`.
	Processor component.ID `mapstructure:"processor"`

	// prevent unkeyed literal initialization
	_ struct{}
}

var _ component.Config = (*ExtensionConfig)(nil)

// NewExtensionFactory returns the factory for the ouoratelimit extension
// (import it from the ouoratelimitextension package, which ocb can name).
func NewExtensionFactory() extension.Factory {
	return extension.NewFactory(
		metadata.Type,
		func() component.Config { return &ExtensionConfig{Processor: component.NewID(metadata.Type)} },
		createExtension,
		metadata.ExtensionStability,
	)
}

func createExtension(_ context.Context, set extension.Settings, cfg component.Config) (extension.Extension, error) {
	rejected, err := rejectedCounter(set.TelemetrySettings)
	if err != nil {
		return nil, err
	}
	return &edgeLimiter{processor: cfg.(*ExtensionConfig).Processor, rejected: rejected, logger: set.Logger}, nil
}

type edgeLimiter struct {
	component.StartFunc
	component.ShutdownFunc

	processor component.ID
	rejected  metric.Int64Counter
	logger    *zap.Logger
}

var (
	_ extensionmiddleware.HTTPServer = (*edgeLimiter)(nil)
	_ extensionmiddleware.GRPCServer = (*edgeLimiter)(nil)
)

// GetHTTPHandler wraps the receiver's handler. confighttp runs middlewares
// after authentication, so the client context already holds auth.username.
func (e *edgeLimiter) GetHTTPHandler(context.Context) (extensionmiddleware.WrapHTTPHandlerFunc, error) {
	return func(_ context.Context, next http.Handler) (http.Handler, error) {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			lim := sharedLimiter(e.processor)
			if lim == nil {
				// The processor is not in a running pipeline: nothing to charge.
				next.ServeHTTP(w, r)
				return
			}
			if st := admit(r.Context(), lim, e.rejected, e.logger); st != nil {
				writeHTTPStatus(w, r, st)
				return
			}
			next.ServeHTTP(w, r.WithContext(withCharged(r.Context())))
		}), nil
	}, nil
}

// GetGRPCServerOptions adds a unary interceptor; configgrpc chains it after
// the client-info and auth interceptors.
func (e *edgeLimiter) GetGRPCServerOptions(context.Context) ([]grpc.ServerOption, error) {
	return []grpc.ServerOption{grpc.ChainUnaryInterceptor(e.unary)}, nil
}

func (e *edgeLimiter) unary(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	lim := sharedLimiter(e.processor)
	if lim == nil {
		return handler(ctx, req)
	}
	if st := admit(ctx, lim, e.rejected, e.logger); st != nil {
		return nil, st.Err()
	}
	return handler(withCharged(ctx), req)
}

// writeHTTPStatus answers 429 the way the OTLP receiver does for a processor
// rejection: Retry-After from the RetryInfo and the google.rpc.Status body in
// the request's encoding (JSON or protobuf).
func writeHTTPStatus(w http.ResponseWriter, r *http.Request, st *status.Status) {
	for _, d := range st.Details() {
		if ri, ok := d.(*errdetails.RetryInfo); ok {
			w.Header().Set("Retry-After", strconv.FormatInt(int64(ri.GetRetryDelay().AsDuration().Seconds()), 10))
		}
	}
	ct := "application/x-protobuf"
	body, err := proto.Marshal(st.Proto())
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt == "application/json" {
		ct = "application/json"
		body, err = protojson.Marshal(st.Proto())
	}
	if err != nil {
		http.Error(w, st.Message(), http.StatusTooManyRequests)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = w.Write(body)
}
