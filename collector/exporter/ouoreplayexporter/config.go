package ouoreplayexporter // import "github.com/ouo11y/ouo11y/collector/exporter/ouoreplayexporter"

import (
	"errors"
	"net/url"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/confighttp"
	"go.opentelemetry.io/collector/config/configopaque"
	"go.opentelemetry.io/collector/config/configoptional"
	"go.opentelemetry.io/collector/config/configretry"
	"go.opentelemetry.io/collector/exporter/exporterhelper"
)

const (
	// DefaultEndpoint is rum-api's in-network address.
	DefaultEndpoint = "http://rum-api:8080"
	// ChunksPath is appended to the endpoint.
	ChunksPath = "/v1/replay/chunks"
)

// Config is the exporter configuration. ClientConfig brings the standard
// confighttp client keys (endpoint, timeout, tls, headers, compression,
// proxy_url, ...). `endpoint` is the rum-api base URL.
type Config struct {
	// ClientConfig is a named field, not an anonymous embedding, so that
	// confighttp's methods (Unmarshal in particular) are not promoted to
	// Config, which would make confmap drop the sibling keys below.
	ClientConfig confighttp.ClientConfig `mapstructure:",squash"`

	// IngestToken is sent as `Authorization: Bearer <token>` when set
	// (rum-api's OUO_INGEST_TOKEN).
	IngestToken configopaque.String `mapstructure:"ingest_token"`

	QueueConfig configoptional.Optional[exporterhelper.QueueBatchConfig] `mapstructure:"sending_queue"`
	RetryConfig configretry.BackOffConfig                                `mapstructure:"retry_on_failure"`

	// prevent unkeyed literal initialization
	_ struct{}
}

var _ component.Config = (*Config)(nil)

// Validate implements component.ConfigValidator.
func (cfg *Config) Validate() error {
	if cfg.ClientConfig.Endpoint == "" {
		return errors.New("endpoint must not be empty")
	}
	u, err := url.Parse(cfg.ClientConfig.Endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return errors.New("endpoint must be an absolute http(s) URL, e.g. http://rum-api:8080")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("endpoint scheme must be http or https")
	}
	return nil
}
