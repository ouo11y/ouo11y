// Package metadata holds the component type and stability (hand-written in
// the mdatagen shape, see ../../metadata.yaml).
package metadata

import "go.opentelemetry.io/collector/component"

var (
	// Type is the component type used in collector configs: exporters.ouoreplay.
	Type = component.MustNewType("ouoreplay")
	// ScopeName is the instrumentation scope of the exporter's own telemetry.
	ScopeName = "github.com/ZiadMansourM/ouo/collector/exporter/ouoreplayexporter"
)

const (
	LogsStability = component.StabilityLevelAlpha
)
