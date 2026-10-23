package ouoauthextension // import "github.com/ouo11y/ouo11y/collector/extension/ouoauthextension"

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/extension"

	"github.com/ouo11y/ouo11y/collector/extension/ouoauthextension/internal/metadata"
)

// NewFactory returns the factory for the ouoauth extension.
func NewFactory() extension.Factory {
	return extension.NewFactory(metadata.Type, createDefaultConfig, create, metadata.ExtensionStability)
}

func createDefaultConfig() component.Config {
	return &Config{}
}

func create(_ context.Context, set extension.Settings, cfg component.Config) (extension.Extension, error) {
	return newAuthenticator(set.ID, cfg.(*Config), set.TelemetrySettings)
}
