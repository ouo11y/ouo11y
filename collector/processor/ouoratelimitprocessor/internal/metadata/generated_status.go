// Package metadata holds the component type and stability (hand-written in
// the mdatagen shape, see ../../metadata.yaml).
package metadata

import "go.opentelemetry.io/collector/component"

var (
	// Type is the component type used in collector configs: processors.ouoratelimit.
	Type = component.MustNewType("ouoratelimit")
	// ScopeName is the instrumentation scope of the processor's own telemetry.
	ScopeName = "github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor"
)

const (
	TracesStability  = component.StabilityLevelAlpha
	MetricsStability = component.StabilityLevelAlpha
	LogsStability    = component.StabilityLevelAlpha
	// ExtensionStability is the stability of the ouoratelimit extension (the receiver middleware).
	ExtensionStability = component.StabilityLevelAlpha
)
