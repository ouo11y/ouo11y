package ouoauthextension // import "github.com/ouo11y/ouo11y/collector/extension/ouoauthextension"

import (
	"errors"

	"go.opentelemetry.io/collector/component"
)

// Config is the extension configuration.
type Config struct {
	// Authenticator is the ID of the server authenticator extension to
	// delegate to, e.g. basicauth/server. It must be listed in
	// service.extensions too.
	Authenticator component.ID `mapstructure:"authenticator"`

	// prevent unkeyed literal initialization
	_ struct{}
}

var _ component.Config = (*Config)(nil)

// Validate implements component.ConfigValidator.
func (cfg *Config) Validate() error {
	if cfg.Authenticator == (component.ID{}) {
		return errors.New("authenticator must name the server authenticator extension to wrap")
	}
	return nil
}
