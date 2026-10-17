package ouoreplayreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouoreplayreceiver"

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/confighttp"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/receiver"

	"github.com/ouo11y/ouo11y/collector/receiver/ouoreplayreceiver/internal/metadata"
)

// NewFactory returns the factory for the ouoreplay receiver.
func NewFactory() receiver.Factory {
	return receiver.NewFactory(
		metadata.Type,
		createDefaultConfig,
		receiver.WithLogs(createLogs, metadata.LogsStability),
	)
}

func createDefaultConfig() component.Config {
	sc := confighttp.NewDefaultServerConfig()
	sc.NetAddr.Endpoint = DefaultEndpoint
	sc.MaxRequestBodySize = DefaultMaxRequestBodySize
	return &Config{
		ServerConfig:       sc,
		MaxRRWebChunkBytes: DefaultMaxRRWebChunkBytes,
	}
}

func createLogs(_ context.Context, set receiver.Settings, cfg component.Config, next consumer.Logs) (receiver.Logs, error) {
	return newReceiver(set, cfg.(*Config), next)
}
