// Package metadata holds the component type and stability (hand-written in
// the mdatagen shape, see ../../metadata.yaml).
package metadata

import "go.opentelemetry.io/collector/component"

var (
	// Type is the component type used in collector configs: extensions.ouoauth.
	Type = component.MustNewType("ouoauth")
	// ScopeName is the instrumentation scope of the extension's own telemetry.
	ScopeName = "github.com/ouo11y/ouo11y/collector/extension/ouoauthextension"
)

const (
	ExtensionStability = component.StabilityLevelAlpha
)
