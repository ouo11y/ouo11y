package ouoreplayreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouoreplayreceiver"

import (
	"errors"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/confighttp"
)

const (
	// DefaultEndpoint is the listen address when `endpoint` is not set.
	DefaultEndpoint = "0.0.0.0:4319"
	// DefaultMaxRequestBodySize bounds the decompressed body (frames chunks
	// may be up to 8 MiB, docs/specs/mobile-replay.md).
	DefaultMaxRequestBodySize int64 = 8 << 20
	// DefaultMaxRRWebChunkBytes bounds rrweb chunks (ADR-0003 flushes at
	// 256 KB; 4 MiB is the same ceiling rum-api applies).
	DefaultMaxRRWebChunkBytes int64 = 4 << 20
	// DefaultPath is the route of the chunk sink.
	DefaultPath = "/v1/replay/chunks"
)

// Config is the receiver configuration. The HTTP server options are the
// standard confighttp ones (endpoint, tls, cors, auth, max_request_body_size,
// include_metadata, compression_algorithms, ...).
type Config struct {
	// ServerConfig is a named field, not an anonymous embedding: an embedded
	// confighttp.ServerConfig would promote its Unmarshal method to Config and
	// confmap would then silently drop every sibling key (max_rrweb_chunk_bytes).
	ServerConfig confighttp.ServerConfig `mapstructure:",squash"`

	// MaxRRWebChunkBytes is the largest rrweb chunk accepted (decompressed).
	// A larger body is accepted only when its `kind` is "frames", which is
	// bounded by max_request_body_size instead. 0 means max_request_body_size.
	MaxRRWebChunkBytes int64 `mapstructure:"max_rrweb_chunk_bytes"`

	// prevent unkeyed literal initialization
	_ struct{}
}

var _ component.Config = (*Config)(nil)

// Validate implements component.ConfigValidator.
func (cfg *Config) Validate() error {
	if cfg.ServerConfig.NetAddr.Endpoint == "" {
		return errors.New("endpoint must not be empty")
	}
	if cfg.ServerConfig.MaxRequestBodySize < 0 {
		return errors.New("max_request_body_size must not be negative")
	}
	if cfg.MaxRRWebChunkBytes < 0 {
		return errors.New("max_rrweb_chunk_bytes must not be negative")
	}
	if cfg.ServerConfig.MaxRequestBodySize > 0 && cfg.MaxRRWebChunkBytes > cfg.ServerConfig.MaxRequestBodySize {
		return errors.New("max_rrweb_chunk_bytes must not exceed max_request_body_size")
	}
	return nil
}
