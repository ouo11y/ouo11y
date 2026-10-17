package ouoratelimitprocessor // import "github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor"

import (
	"errors"
	"fmt"
	"time"

	"go.opentelemetry.io/collector/component"
)

// Client key sources.
const (
	KeyFromAddress       = "address"
	KeyFromXForwardedFor = "x_forwarded_for"
)

// Defaults (ADR-0007 section 4).
const (
	DefaultProjectRate  = 1000.0
	DefaultProjectBurst = 5000
	DefaultClientRate   = 100.0
	DefaultClientBurst  = 300
	DefaultIdleTimeout  = 10 * time.Minute
)

// BucketConfig is one token bucket: `rate` tokens per second refill, at most
// `burst` tokens. rate 0 disables the bucket kind.
type BucketConfig struct {
	Rate  float64 `mapstructure:"rate"`
	Burst int     `mapstructure:"burst"`

	// prevent unkeyed literal initialization
	_ struct{}
}

// ClientBucketConfig is the per-client bucket plus where the client key comes from.
type ClientBucketConfig struct {
	BucketConfig `mapstructure:",squash"`

	// KeyFrom is `address` (client.Info.Addr, the TCP peer) or
	// `x_forwarded_for` (first hop of the X-Forwarded-For request header,
	// falling back to the address when absent). The header case requires
	// `include_metadata: true` on the receiver and must only be used behind
	// a proxy that sets the header (Caddy does), otherwise clients choose
	// their own key.
	KeyFrom string `mapstructure:"key_from"`

	// prevent unkeyed literal initialization
	_ struct{}
}

// Config is the processor configuration.
type Config struct {
	// Project limits requests per authenticated project (auth.username).
	Project BucketConfig `mapstructure:"project"`
	// Client limits requests per client address.
	Client ClientBucketConfig `mapstructure:"client"`
	// IdleTimeout drops buckets not used for this long (they are full by then).
	IdleTimeout time.Duration `mapstructure:"idle_timeout"`

	// prevent unkeyed literal initialization
	_ struct{}
}

var _ component.Config = (*Config)(nil)

func (b BucketConfig) validate(name string) error {
	if b.Rate < 0 {
		return fmt.Errorf("%s.rate must not be negative", name)
	}
	if b.Rate > 0 && b.Burst < 1 {
		return fmt.Errorf("%s.burst must be at least 1 when %s.rate is set", name, name)
	}
	return nil
}

// Validate implements component.ConfigValidator.
func (cfg *Config) Validate() error {
	if err := cfg.Project.validate("project"); err != nil {
		return err
	}
	if err := cfg.Client.validate("client"); err != nil {
		return err
	}
	switch cfg.Client.KeyFrom {
	case KeyFromAddress, KeyFromXForwardedFor:
	default:
		return fmt.Errorf("client.key_from must be %q or %q", KeyFromAddress, KeyFromXForwardedFor)
	}
	if cfg.IdleTimeout <= 0 {
		return errors.New("idle_timeout must be positive")
	}
	return nil
}
