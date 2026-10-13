package ouosentryreceiver // import "github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver"

import (
	"context"
	"sync"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/confighttp"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/receiver"

	"github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver/internal/metadata"
)

// NewFactory returns the factory for the ouosentry receiver. One receiver
// instance (one HTTP server) serves both the logs and the traces pipelines
// it is configured in.
func NewFactory() receiver.Factory {
	return receiver.NewFactory(
		metadata.Type,
		createDefaultConfig,
		receiver.WithLogs(createLogs, metadata.LogsStability),
		receiver.WithTraces(createTraces, metadata.TracesStability),
	)
}

func createDefaultConfig() component.Config {
	sc := confighttp.NewDefaultServerConfig()
	sc.NetAddr.Endpoint = DefaultEndpoint
	sc.MaxRequestBodySize = DefaultMaxRequestBodySize
	return &Config{
		ServerConfig:       sc,
		UpstreamTimeout:    DefaultUpstreamTimeout,
		MaxTranslateBytes:  DefaultMaxTranslateBytes,
		TranslateQueueSize: DefaultTranslateQueueSize,
		State:              StateConfig{MaxSessions: 200000, TTL: 4 * time.Hour, ReplayHold: 10 * time.Minute},
	}
}

// shared keeps one receiver per configuration, the pattern upstream's
// sharedcomponent implements (it is internal to the collector modules).
var shared = struct {
	sync.Mutex
	m map[*Config]*sentryReceiver
}{m: map[*Config]*sentryReceiver{}}

func getOrCreate(set receiver.Settings, cfg *Config) (*sentryReceiver, error) {
	shared.Lock()
	defer shared.Unlock()
	if r, ok := shared.m[cfg]; ok {
		return r, nil
	}
	r, err := newReceiver(set, cfg)
	if err != nil {
		return nil, err
	}
	r.release = func() {
		shared.Lock()
		delete(shared.m, cfg)
		shared.Unlock()
	}
	shared.m[cfg] = r
	return r, nil
}

func createLogs(_ context.Context, set receiver.Settings, cfg component.Config, next consumer.Logs) (receiver.Logs, error) {
	r, err := getOrCreate(set, cfg.(*Config))
	if err != nil {
		return nil, err
	}
	r.setLogs(next)
	return r, nil
}

func createTraces(_ context.Context, set receiver.Settings, cfg component.Config, next consumer.Traces) (receiver.Traces, error) {
	r, err := getOrCreate(set, cfg.(*Config))
	if err != nil {
		return nil, err
	}
	r.setTraces(next)
	return r, nil
}
