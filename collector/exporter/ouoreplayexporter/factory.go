package ouoreplayexporter // import "github.com/ouo11y/ouo11y/collector/exporter/ouoreplayexporter"

import (
	"context"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/configcompression"
	"go.opentelemetry.io/collector/config/confighttp"
	"go.opentelemetry.io/collector/config/configoptional"
	"go.opentelemetry.io/collector/config/configretry"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/exporter"
	"go.opentelemetry.io/collector/exporter/exporterhelper"

	"github.com/ouo11y/ouo11y/collector/exporter/ouoreplayexporter/internal/metadata"
)

// NewFactory returns the factory for the ouoreplay exporter.
func NewFactory() exporter.Factory {
	return exporter.NewFactory(
		metadata.Type,
		createDefaultConfig,
		exporter.WithLogs(createLogs, metadata.LogsStability),
	)
}

func createDefaultConfig() component.Config {
	cc := confighttp.NewDefaultClientConfig()
	cc.Endpoint = DefaultEndpoint
	cc.Timeout = 30 * time.Second
	// Chunks are JSON up to 8 MiB; rum-api accepts gzip and stores the gzip
	// bytes as-is, so compressing here saves network and rum-api CPU.
	cc.Compression = configcompression.TypeGzip
	return &Config{
		ClientConfig: cc,
		QueueConfig:  configoptional.Some(exporterhelper.NewDefaultQueueConfig()),
		RetryConfig:  configretry.NewDefaultBackOffConfig(),
	}
}

func createLogs(ctx context.Context, set exporter.Settings, cfg component.Config) (exporter.Logs, error) {
	oCfg := cfg.(*Config)
	e := newExporter(oCfg, set)
	return exporterhelper.NewLogs(ctx, set, cfg,
		e.pushLogs,
		exporterhelper.WithStart(e.start),
		exporterhelper.WithCapabilities(consumer.Capabilities{MutatesData: false}),
		// The HTTP client timeout (ClientConfig.Timeout) bounds each request.
		exporterhelper.WithTimeout(exporterhelper.TimeoutConfig{Timeout: 0}),
		exporterhelper.WithRetry(oCfg.RetryConfig),
		exporterhelper.WithQueue(oCfg.QueueConfig),
	)
}
