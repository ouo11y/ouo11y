package ouoreplayexporter

import (
	"testing"
	"time"

	"go.opentelemetry.io/collector/confmap"
)

// TestConfigUnmarshal loads the config the way the collector does. It guards
// against confighttp's Unmarshal being promoted to Config (anonymous
// embedding), which silently dropped ingest_token, sending_queue and
// retry_on_failure.
func TestConfigUnmarshal(t *testing.T) {
	conf := confmap.NewFromStringMap(map[string]any{
		"endpoint":         "http://rum-api:8080",
		"ingest_token":     "it_dev_0000000000000000",
		"timeout":          "7s",
		"sending_queue":    map[string]any{"enabled": true, "queue_size": 42},
		"retry_on_failure": map[string]any{"enabled": false},
	})
	cfg := createDefaultConfig().(*Config)
	if err := conf.Unmarshal(cfg); err != nil {
		t.Fatal(err)
	}
	if string(cfg.IngestToken) != "it_dev_0000000000000000" {
		t.Fatalf("ingest_token lost: %q", cfg.IngestToken)
	}
	if cfg.ClientConfig.Timeout != 7*time.Second || cfg.ClientConfig.Endpoint != "http://rum-api:8080" {
		t.Fatalf("client config: %+v", cfg.ClientConfig)
	}
	if !cfg.QueueConfig.HasValue() || cfg.QueueConfig.Get().QueueSize != 42 || cfg.RetryConfig.Enabled {
		t.Fatalf("queue/retry: %+v %+v", cfg.QueueConfig, cfg.RetryConfig)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}
