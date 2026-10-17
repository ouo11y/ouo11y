// Package metadata holds the component type and stability, the same shape
// mdatagen produces for upstream components (hand-written here, see
// ../../metadata.yaml).
package metadata

import (
	"go.opentelemetry.io/collector/component"
)

var (
	// Type is the component type used in collector configs: receivers.ouoreplay.
	Type = component.MustNewType("ouoreplay")
	// ScopeName is the instrumentation scope of the receiver's own telemetry.
	ScopeName = "github.com/ouo11y/ouo11y/collector/receiver/ouoreplayreceiver"
)

const (
	LogsStability = component.StabilityLevelAlpha
)
