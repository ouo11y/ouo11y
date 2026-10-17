package ouoratelimitprocessor // import "github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor"

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/processor/processorhelper"

	"github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor/internal/metadata"
)

var capabilities = consumer.Capabilities{MutatesData: false}

// NewFactory returns the factory for the ouoratelimit processor.
func NewFactory() processor.Factory {
	return processor.NewFactory(
		metadata.Type,
		createDefaultConfig,
		processor.WithTraces(createTraces, metadata.TracesStability),
		processor.WithMetrics(createMetrics, metadata.MetricsStability),
		processor.WithLogs(createLogs, metadata.LogsStability),
	)
}

func createDefaultConfig() component.Config {
	return &Config{
		Project: BucketConfig{Rate: DefaultProjectRate, Burst: DefaultProjectBurst},
		Client: ClientBucketConfig{
			BucketConfig: BucketConfig{Rate: DefaultClientRate, Burst: DefaultClientBurst},
			KeyFrom:      KeyFromAddress,
		},
		IdleTimeout: DefaultIdleTimeout,
	}
}

func createTraces(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Traces) (processor.Traces, error) {
	p, err := newProcessor(set.ID, cfg.(*Config), set.TelemetrySettings)
	if err != nil {
		return nil, err
	}
	return processorhelper.NewTraces(ctx, set, cfg, next, p.processTraces,
		processorhelper.WithCapabilities(capabilities),
		processorhelper.WithStart(p.start), processorhelper.WithShutdown(p.shutdown))
}

func createMetrics(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Metrics) (processor.Metrics, error) {
	p, err := newProcessor(set.ID, cfg.(*Config), set.TelemetrySettings)
	if err != nil {
		return nil, err
	}
	return processorhelper.NewMetrics(ctx, set, cfg, next, p.processMetrics,
		processorhelper.WithCapabilities(capabilities),
		processorhelper.WithStart(p.start), processorhelper.WithShutdown(p.shutdown))
}

func createLogs(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Logs) (processor.Logs, error) {
	p, err := newProcessor(set.ID, cfg.(*Config), set.TelemetrySettings)
	if err != nil {
		return nil, err
	}
	return processorhelper.NewLogs(ctx, set, cfg, next, p.processLogs,
		processorhelper.WithCapabilities(capabilities),
		processorhelper.WithStart(p.start), processorhelper.WithShutdown(p.shutdown))
}
