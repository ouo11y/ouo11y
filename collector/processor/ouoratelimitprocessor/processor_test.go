package ouoratelimitprocessor

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor/processortest"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor/internal/metadata"
)

type auth struct{ user string }

func (a auth) GetAttribute(k string) any {
	if k == "username" {
		return a.user
	}
	return nil
}
func (a auth) GetAttributeNames() []string { return []string{"username"} }

func ctxFor(project, ip string, md map[string][]string) context.Context {
	ci := client.Info{Metadata: client.NewMetadata(md)}
	if project != "" {
		ci.Auth = auth{project}
	}
	if ip != "" {
		ci.Addr = &net.IPAddr{IP: net.ParseIP(ip)}
	}
	return client.NewContext(context.Background(), ci)
}

func TestConfig(t *testing.T) {
	cfg := createDefaultConfig().(*Config)
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if cfg.Project.Rate != 1000 || cfg.Project.Burst != 5000 || cfg.Client.Rate != 100 || cfg.Client.Burst != 300 || cfg.Client.KeyFrom != KeyFromAddress {
		t.Fatalf("defaults: %+v", cfg)
	}
	for name, mut := range map[string]func(*Config){
		"negative rate": func(c *Config) { c.Project.Rate = -1 },
		"zero burst":    func(c *Config) { c.Client.Burst = 0 },
		"bad key_from":  func(c *Config) { c.Client.KeyFrom = "header" },
		"idle":          func(c *Config) { c.IdleTimeout = 0 },
	} {
		c := createDefaultConfig().(*Config)
		mut(c)
		if c.Validate() == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
	c := createDefaultConfig().(*Config)
	c.Client.Rate, c.Client.Burst = 0, 0 // disabled bucket kind is valid
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestLimiterBuckets(t *testing.T) {
	cfg := createDefaultConfig().(*Config)
	cfg.Project = BucketConfig{Rate: 10, Burst: 5}
	cfg.Client.BucketConfig = BucketConfig{Rate: 1, Burst: 3}
	l := newLimiter(cfg)
	now := time.Unix(1000, 0)
	l.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if k, _ := l.allow("demo", "1.1.1.1"); k != "" {
			t.Fatalf("request %d rejected by %s", i, k)
		}
	}
	k, d := l.allow("demo", "1.1.1.1")
	if k != keyKindClient || d != time.Second {
		t.Fatalf("got %q %v, want client 1s", k, d)
	}
	// Another client of the same project: project bucket has 2 tokens left.
	for i := 0; i < 2; i++ {
		if k, _ := l.allow("demo", "2.2.2.2"); k != "" {
			t.Fatalf("second client request %d rejected by %s", i, k)
		}
	}
	if k, d := l.allow("demo", "2.2.2.2"); k != keyKindProject || d != 100*time.Millisecond {
		t.Fatalf("got %q %v, want project 100ms", k, d)
	}
	// The rejection took no client token: client 2 still has 1 token.
	if k, _ := l.allow("other", "2.2.2.2"); k != "" {
		t.Fatalf("other project rejected by %s", k)
	}
	// Refill.
	now = now.Add(time.Second)
	if k, _ := l.allow("demo", "1.1.1.1"); k != "" {
		t.Fatalf("after refill rejected by %s", k)
	}
	// Sweep idle buckets.
	if p, c := l.size(); p != 2 || c != 2 {
		t.Fatalf("size %d %d", p, c)
	}
	now = now.Add(cfg.IdleTimeout + time.Second)
	l.sweep()
	if p, c := l.size(); p != 0 || c != 0 {
		t.Fatalf("after sweep %d %d", p, c)
	}
	// No keys: always allowed.
	for i := 0; i < 100; i++ {
		if k, _ := l.allow("", ""); k != "" {
			t.Fatal("keyless request rejected")
		}
	}
}

func TestClientKey(t *testing.T) {
	md := map[string][]string{"x-forwarded-for": {"203.0.113.7, 10.0.0.1"}}
	ci := client.FromContext(ctxFor("demo", "172.18.0.5", md))
	if got := clientKey(ci, KeyFromAddress); got != "172.18.0.5" {
		t.Fatalf("address key %q", got)
	}
	if got := clientKey(ci, KeyFromXForwardedFor); got != "203.0.113.7" {
		t.Fatalf("xff key %q", got)
	}
	ci = client.FromContext(ctxFor("demo", "172.18.0.5", nil))
	if got := clientKey(ci, KeyFromXForwardedFor); got != "172.18.0.5" {
		t.Fatalf("xff fallback %q", got)
	}
	ci = client.Info{Addr: &net.TCPAddr{IP: net.ParseIP("::1"), Port: 5000}}
	if got := clientKey(ci, KeyFromAddress); got != "::1" {
		t.Fatalf("tcp key %q", got)
	}
}

func TestProcessorRejectsWithRetryableStatus(t *testing.T) {
	cfg := createDefaultConfig().(*Config)
	cfg.Client.BucketConfig = BucketConfig{Rate: 1, Burst: 2}
	id := component.MustNewIDWithName("ouoratelimit", t.Name())
	set := processortest.NewNopSettings(metadata.Type)
	set.ID = id
	f := NewFactory()
	tsink, lsink, msink := new(consumertest.TracesSink), new(consumertest.LogsSink), new(consumertest.MetricsSink)
	tp, err := f.CreateTraces(context.Background(), set, cfg, tsink)
	if err != nil {
		t.Fatal(err)
	}
	lp, err := f.CreateLogs(context.Background(), set, cfg, lsink)
	if err != nil {
		t.Fatal(err)
	}
	mp, err := f.CreateMetrics(context.Background(), set, cfg, msink)
	if err != nil {
		t.Fatal(err)
	}
	host := componenttest.NewNopHost()
	for _, c := range []component.Component{tp, lp, mp} {
		if err := c.Start(context.Background(), host); err != nil {
			t.Fatal(err)
		}
	}
	ctx := ctxFor("demo", "198.51.100.1", nil)
	// The three pipelines share one bucket: burst 2 -> trace ok, log ok, metric rejected.
	if err := tp.ConsumeTraces(ctx, ptrace.NewTraces()); err != nil {
		t.Fatal(err)
	}
	if err := lp.ConsumeLogs(ctx, plog.NewLogs()); err != nil {
		t.Fatal(err)
	}
	err = mp.ConsumeMetrics(ctx, pmetric.NewMetrics())
	if err == nil {
		t.Fatal("third request should be rejected")
	}
	if consumererror.IsPermanent(err) {
		t.Fatal("rejection must not be permanent")
	}
	st, ok := status.FromError(err)
	if !ok || st.Code() != codes.ResourceExhausted {
		t.Fatalf("status %v", err)
	}
	var ri *errdetails.RetryInfo
	for _, d := range st.Details() {
		if r, ok := d.(*errdetails.RetryInfo); ok {
			ri = r
		}
	}
	if ri == nil || ri.GetRetryDelay().AsDuration() != time.Second {
		t.Fatalf("retry info %v", ri)
	}
	if tsink.SpanCount() != 0 || len(tsink.AllTraces()) != 1 || len(lsink.AllLogs()) != 1 || len(msink.AllMetrics()) != 0 {
		t.Fatal("unexpected sink contents")
	}
	for _, c := range []component.Component{tp, lp, mp} {
		if err := c.Shutdown(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	sharedMu.Lock()
	_, still := limiters[id]
	sharedMu.Unlock()
	if still {
		t.Fatal("shared limiter not released after the last shutdown")
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal("unexpected")
	}
}
