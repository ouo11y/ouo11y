package ouoratelimitprocessor

import (
	"testing"
	"time"

	"go.opentelemetry.io/collector/confmap"
)

func TestConfigUnmarshal(t *testing.T) {
	conf := confmap.NewFromStringMap(map[string]any{
		"project":      map[string]any{"rate": 50, "burst": 60},
		"client":       map[string]any{"rate": 5.5, "burst": 7, "key_from": "x_forwarded_for"},
		"idle_timeout": "1m",
	})
	cfg := createDefaultConfig().(*Config)
	if err := conf.Unmarshal(cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Project.Rate != 50 || cfg.Project.Burst != 60 || cfg.Client.Rate != 5.5 || cfg.Client.Burst != 7 ||
		cfg.Client.KeyFrom != KeyFromXForwardedFor || cfg.IdleTimeout != time.Minute {
		t.Fatalf("unmarshal: %+v", cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}
