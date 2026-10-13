package ouoratelimitprocessor // import "github.com/ZiadMansourM/ouo/collector/processor/ouoratelimitprocessor"

import (
	"context"
	"fmt"
	"math"
	"net"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.uber.org/zap"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/ZiadMansourM/ouo/collector/processor/ouoratelimitprocessor/internal/metadata"
)

const (
	keyKindProject = "project"
	keyKindClient  = "client"
	// authUsername is the client.Info.Auth attribute basicauth fills.
	authUsername = "username"
	// headerXFF is read from client.Info.Metadata (include_metadata: true).
	headerXFF = "X-Forwarded-For"
)

// shared holds one limiter per component ID: the collector creates one
// processor instance per pipeline, and the limits are meant per request
// across all signals.
type shared struct {
	lim  *limiter
	refs int
	stop chan struct{}
	done chan struct{}
}

var (
	sharedMu sync.Mutex
	limiters = map[component.ID]*shared{}
)

type rateLimitProcessor struct {
	id       component.ID
	cfg      *Config
	logger   *zap.Logger
	rejected metric.Int64Counter
	lim      *limiter
}

func newProcessor(id component.ID, cfg *Config, set component.TelemetrySettings) (*rateLimitProcessor, error) {
	meter := set.MeterProvider.Meter(metadata.ScopeName)
	rejected, err := meter.Int64Counter("ouo_ratelimit_rejected_total",
		metric.WithDescription("Requests rejected by the rate limiter, by the bucket that rejected them."),
		metric.WithUnit("{request}"))
	if err != nil {
		return nil, err
	}
	return &rateLimitProcessor{id: id, cfg: cfg, logger: set.Logger, rejected: rejected}, nil
}

// start attaches to (or creates) the shared limiter of this component ID and
// starts its idle sweeper.
func (p *rateLimitProcessor) start(context.Context, component.Host) error {
	sharedMu.Lock()
	defer sharedMu.Unlock()
	s, ok := limiters[p.id]
	if !ok {
		s = &shared{lim: newLimiter(p.cfg), stop: make(chan struct{}), done: make(chan struct{})}
		limiters[p.id] = s
		interval := p.cfg.IdleTimeout / 2
		go func() {
			defer close(s.done)
			t := time.NewTicker(interval)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					s.lim.sweep()
				case <-s.stop:
					return
				}
			}
		}()
	}
	s.refs++
	p.lim = s.lim
	return nil
}

func (p *rateLimitProcessor) shutdown(context.Context) error {
	sharedMu.Lock()
	defer sharedMu.Unlock()
	s, ok := limiters[p.id]
	if !ok || p.lim == nil {
		return nil
	}
	p.lim = nil
	s.refs--
	if s.refs == 0 {
		close(s.stop)
		<-s.done
		delete(limiters, p.id)
	}
	return nil
}

// keys returns the project key (authenticated username) and the client key.
func (p *rateLimitProcessor) keys(ctx context.Context) (string, string) {
	ci := client.FromContext(ctx)
	var project string
	if ci.Auth != nil {
		if s, ok := ci.Auth.GetAttribute(authUsername).(string); ok {
			project = s
		}
	}
	return project, clientKey(ci, p.cfg.Client.KeyFrom)
}

func clientKey(ci client.Info, keyFrom string) string {
	if keyFrom == KeyFromXForwardedFor {
		for _, v := range ci.Metadata.Get(headerXFF) {
			first, _, _ := strings.Cut(v, ",")
			if first = strings.TrimSpace(first); first != "" {
				return first
			}
		}
	}
	switch a := ci.Addr.(type) {
	case nil:
		return ""
	case *net.IPAddr:
		return a.IP.String()
	case *net.TCPAddr:
		return a.IP.String()
	case *net.UDPAddr:
		return a.IP.String()
	default:
		if h, _, err := net.SplitHostPort(a.String()); err == nil {
			return h
		}
		return a.String()
	}
}

// check returns nil or the retryable rejection error.
func (p *rateLimitProcessor) check(ctx context.Context) error {
	if p.lim == nil {
		return nil
	}
	project, clientK := p.keys(ctx)
	kind, d := p.lim.allow(project, clientK)
	if kind == "" {
		return nil
	}
	p.rejected.Add(ctx, 1, metric.WithAttributes(attribute.String("key_kind", kind)))
	secs := int64(math.Ceil(d.Seconds()))
	if secs < 1 {
		secs = 1
	}
	key := project
	if kind == keyKindClient {
		key = clientK
	}
	p.logger.Debug("rate limited", zap.String("key_kind", kind), zap.String("key", key), zap.Int64("retry_after_s", secs))
	st, err := status.New(codes.ResourceExhausted, fmt.Sprintf("rate limit exceeded for %s %q, retry after %ds", kind, key, secs)).
		WithDetails(&errdetails.RetryInfo{RetryDelay: durationpb.New(time.Duration(secs) * time.Second)})
	if err != nil {
		return status.Error(codes.ResourceExhausted, "rate limit exceeded")
	}
	return st.Err()
}

func (p *rateLimitProcessor) processTraces(ctx context.Context, td ptrace.Traces) (ptrace.Traces, error) {
	return td, p.check(ctx)
}

func (p *rateLimitProcessor) processMetrics(ctx context.Context, md pmetric.Metrics) (pmetric.Metrics, error) {
	return md, p.check(ctx)
}

func (p *rateLimitProcessor) processLogs(ctx context.Context, ld plog.Logs) (plog.Logs, error) {
	return ld, p.check(ctx)
}
