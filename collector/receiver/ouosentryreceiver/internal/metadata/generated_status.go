// Package metadata holds the component type and stability, the same shape
// mdatagen produces for upstream components (hand-written here, see
// ../../metadata.yaml).
package metadata

import (
	"go.opentelemetry.io/collector/component"
)

var (
	// Type is the component type used in collector configs: receivers.ouosentry.
	Type = component.MustNewType("ouosentry")
	// ScopeName is the instrumentation scope of the receiver's own telemetry.
	ScopeName = "github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver"
)

const (
	LogsStability   = component.StabilityLevelAlpha
	TracesStability = component.StabilityLevelAlpha
)
