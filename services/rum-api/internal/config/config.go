// Package config reads rum-api settings from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the runtime configuration.
type Config struct {
	Addr               string        // RUM_API_ADDR, default :8080
	LokiURL            string        // LOKI_URL, default http://loki:3100
	TempoURL           string        // TEMPO_URL, default http://tempo:3200
	GrafanaURL         string        // GRAFANA_URL, default http://localhost:3000 (deep links, browser-facing)
	TempoDatasourceUID string        // GRAFANA_TEMPO_DATASOURCE_UID, default tempo
	DataDir            string        // DATA_DIR, default /data
	CORSAllowedOrigins []string      // CORS_ALLOWED_ORIGINS, comma separated extra origins
	SessionInactivity  time.Duration // SESSION_INACTIVITY, default 30m
	SessionMaxDuration time.Duration // SESSION_MAX_DURATION, default 4h (also the Loki lookback for the list)
	TempoConcurrency   int           // TEMPO_CONCURRENCY, default 8
	TempoCacheTTL      time.Duration // TEMPO_CACHE_TTL, default 60s
	MaxChunkBytes      int64         // MAX_CHUNK_BYTES, default 4 MiB (decompressed)
	DetailLookback     time.Duration // SESSION_DETAIL_LOOKBACK, default 168h: how far back GET /v1/sessions/{id} searches Loki
}

// FromEnv builds the config from environment variables with defaults.
func FromEnv() (Config, error) {
	c := Config{
		Addr:               env("RUM_API_ADDR", ":8080"),
		LokiURL:            env("LOKI_URL", "http://loki:3100"),
		TempoURL:           env("TEMPO_URL", "http://tempo:3200"),
		GrafanaURL:         env("GRAFANA_URL", "http://localhost:3000"),
		TempoDatasourceUID: env("GRAFANA_TEMPO_DATASOURCE_UID", "tempo"),
		DataDir:            env("DATA_DIR", "/data"),
	}
	for o := range strings.SplitSeq(os.Getenv("CORS_ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(strings.TrimSuffix(o, "/")); o != "" {
			c.CORSAllowedOrigins = append(c.CORSAllowedOrigins, o)
		}
	}
	var err error
	if c.SessionInactivity, err = envDuration("SESSION_INACTIVITY", 30*time.Minute); err != nil {
		return c, err
	}
	if c.SessionMaxDuration, err = envDuration("SESSION_MAX_DURATION", 4*time.Hour); err != nil {
		return c, err
	}
	if c.TempoCacheTTL, err = envDuration("TEMPO_CACHE_TTL", 60*time.Second); err != nil {
		return c, err
	}
	if c.DetailLookback, err = envDuration("SESSION_DETAIL_LOOKBACK", 168*time.Hour); err != nil {
		return c, err
	}
	if c.TempoConcurrency, err = envInt("TEMPO_CONCURRENCY", 8); err != nil {
		return c, err
	}
	mcb, err := envInt("MAX_CHUNK_BYTES", 4<<20)
	if err != nil {
		return c, err
	}
	c.MaxChunkBytes = int64(mcb)
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}

func envInt(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return n, nil
}
