package ouoreplayreceiver

import (
	"testing"

	"go.opentelemetry.io/collector/confmap"
)

// TestConfigUnmarshal loads the config the way the collector does. It guards
// against confighttp's Unmarshal being promoted to Config (anonymous
// embedding), which silently dropped max_rrweb_chunk_bytes.
func TestConfigUnmarshal(t *testing.T) {
	conf := confmap.NewFromStringMap(map[string]any{
		"endpoint":              "0.0.0.0:14319",
		"include_metadata":      true,
		"max_request_body_size": 1048576,
		"max_rrweb_chunk_bytes": 65536,
		"auth":                  map[string]any{"authenticator": "basicauth/server"},
		"cors":                  map[string]any{"allowed_origins": "http://localhost:*,http://127.0.0.1:*", "allowed_headers": []any{"Authorization"}},
	})
	cfg := createDefaultConfig().(*Config)
	if err := conf.Unmarshal(cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.MaxRRWebChunkBytes != 65536 || cfg.ServerConfig.MaxRequestBodySize != 1048576 || cfg.ServerConfig.NetAddr.Endpoint != "0.0.0.0:14319" || !cfg.ServerConfig.IncludeMetadata {
		t.Fatalf("unmarshal lost keys: %+v", cfg)
	}
	if !cfg.ServerConfig.Auth.HasValue() || cfg.ServerConfig.Auth.Get().Config.AuthenticatorID.String() != "basicauth/server" {
		t.Fatal("auth not decoded")
	}
	// A comma-separated string (what ${env:OUO_ALLOWED_ORIGINS} yields) decodes to a list.
	if o := cfg.ServerConfig.CORS.Get().AllowedOrigins; len(o) != 2 || o[1] != "http://127.0.0.1:*" {
		t.Fatalf("allowed_origins %v", o)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}
