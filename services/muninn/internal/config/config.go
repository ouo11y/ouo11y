// Package config reads Muninn's YAML file (-config.file), with ${VAR} and
// ${VAR:-default} expanded under -config.expand-env, as Loki, Tempo and rum-api do.
// Keys and defaults: docs/specs/muninn.md section 10; example: config.example.yaml.
package config

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
)

type Config struct {
	Server struct {
		HTTPListenPort int `yaml:"http_listen_port"`
	} `yaml:"server"`
	// MultitenancyEnabled: tenant from X-Scope-OrgID; off: tenant "anonymous" (MUN-54).
	MultitenancyEnabled bool `yaml:"multitenancy_enabled"`
	Auth                struct {
		IngestToken string `yaml:"ingest_token"` // Collector -> POST /otlp/v1/logs
		ReadToken   string `yaml:"read_token"`   // BFF -> /api/v1/*
	} `yaml:"auth"`
	Storage struct {
		Backend    string `yaml:"backend"` // filesystem | s3
		Prefix     string `yaml:"prefix"`
		Filesystem struct {
			Directory string `yaml:"directory"`
		} `yaml:"filesystem"`
		S3 store.S3Config `yaml:"s3"`
	} `yaml:"storage"`
	Limits            Limits        `yaml:"limits"`
	StreamIdleTimeout time.Duration `yaml:"stream_idle_timeout"`
	TombstoneTTL      time.Duration `yaml:"tombstone_ttl"`
	Retention         Retention     `yaml:"retention"`
	DebugFiles        DebugFiles    `yaml:"debug_files"`
}

// DebugFiles configures section 13: source maps, dSYM slices and R8 mappings
// uploaded by a client's CI (ADR-0026).
type DebugFiles struct {
	UploadTokens []UploadToken `yaml:"upload_tokens"`
	MaxBytes     struct {
		Sourcemap int64 `yaml:"sourcemap"`
		Dsym      int64 `yaml:"dsym"`
		Proguard  int64 `yaml:"proguard"`
	} `yaml:"max_bytes"`
	Retention struct {
		Default    time.Duration            `yaml:"default"`
		PerProject map[string]time.Duration `yaml:"per_project"`
	} `yaml:"retention"`
}

// UploadToken opens the public upload route for one project of one tenant (DBG-1, DBG-2).
type UploadToken struct {
	Project string `yaml:"project"`
	Tenant  string `yaml:"tenant"`
	Token   string `yaml:"token"`
}

// MaxBytesFor returns the decompressed size limit of a kind; 0 for an unknown kind.
func (d DebugFiles) MaxBytesFor(kind string) int64 {
	switch kind {
	case "sourcemap":
		return d.MaxBytes.Sourcemap
	case "dsym":
		return d.MaxBytes.Dsym
	case "proguard":
		return d.MaxBytes.Proguard
	}
	return 0
}

// RetentionFor returns a project's debug-file retention; 0 keeps files forever (DBG-20).
func (d DebugFiles) RetentionFor(project string) time.Duration {
	if v, ok := d.Retention.PerProject[project]; ok {
		return v
	}
	return d.Retention.Default
}

type Limits struct {
	MaxChunkBytes     int `yaml:"max_chunk_bytes"`
	MaxAttributeBytes int `yaml:"max_attribute_bytes"`
	MaxRequestBytes   int `yaml:"max_request_bytes"`
}

type Retention struct {
	Default       time.Duration            `yaml:"default"`
	SweepInterval time.Duration            `yaml:"sweep_interval"`
	PerProject    map[string]time.Duration `yaml:"per_project"`
}

// For returns the retention of a project; 0 keeps replays forever (MUN-50).
func (r Retention) For(project string) time.Duration {
	if d, ok := r.PerProject[project]; ok {
		return d
	}
	return r.Default
}

func Defaults() Config {
	var c Config
	c.Server.HTTPListenPort = 3400
	c.Storage.Backend = "filesystem"
	c.Storage.Filesystem.Directory = "/data"
	c.Limits = Limits{MaxChunkBytes: 1 << 20, MaxAttributeBytes: 16 << 10, MaxRequestBytes: 16 << 20}
	c.StreamIdleTimeout = 30 * time.Minute
	c.TombstoneTTL = 168 * time.Hour
	c.Retention = Retention{Default: 720 * time.Hour, SweepInterval: time.Hour}
	c.DebugFiles.MaxBytes.Sourcemap = 64 << 20
	c.DebugFiles.MaxBytes.Dsym = 512 << 20
	c.DebugFiles.MaxBytes.Proguard = 256 << 20
	c.DebugFiles.Retention.Default = 8760 * time.Hour
	return c
}

// Load reads path over the defaults; an empty path gives the defaults.
func Load(path string, expandEnv bool) (Config, error) {
	c := Defaults()
	if path == "" {
		return c, c.Validate()
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if expandEnv {
		raw = ExpandEnv(raw, os.LookupEnv)
	}
	if err := yaml.Unmarshal(raw, &c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	var errs []error
	switch c.Storage.Backend {
	case "filesystem":
		if c.Storage.Filesystem.Directory == "" {
			errs = append(errs, errors.New("storage.filesystem.directory is required"))
		}
	case "s3":
		if c.Storage.S3.Endpoint == "" || c.Storage.S3.Bucket == "" {
			errs = append(errs, errors.New("storage.s3.endpoint and storage.s3.bucket are required"))
		}
	default:
		errs = append(errs, fmt.Errorf("storage.backend %q: want filesystem or s3", c.Storage.Backend))
	}
	if c.Limits.MaxChunkBytes <= 0 || c.Limits.MaxAttributeBytes <= 0 || c.Limits.MaxRequestBytes <= 0 {
		errs = append(errs, errors.New("limits must be positive"))
	}
	if c.DebugFiles.MaxBytes.Sourcemap <= 0 || c.DebugFiles.MaxBytes.Dsym <= 0 || c.DebugFiles.MaxBytes.Proguard <= 0 {
		errs = append(errs, errors.New("debug_files.max_bytes must be positive"))
	}
	seen := map[string]bool{}
	for i, t := range c.DebugFiles.UploadTokens {
		switch {
		case !reProject.MatchString(t.Project):
			errs = append(errs, fmt.Errorf("debug_files.upload_tokens[%d]: project %q is not a project id", i, t.Project))
		case t.Token == "":
			errs = append(errs, fmt.Errorf("debug_files.upload_tokens[%d]: token is empty", i))
		case c.MultitenancyEnabled && !reTenant.MatchString(t.Tenant):
			errs = append(errs, fmt.Errorf("debug_files.upload_tokens[%d]: tenant %q is not a tenant id", i, t.Tenant))
		case seen[t.Token]:
			errs = append(errs, fmt.Errorf("debug_files.upload_tokens[%d]: token used twice", i))
		}
		seen[t.Token] = true
	}
	if c.Retention.SweepInterval <= 0 {
		errs = append(errs, errors.New("retention.sweep_interval must be positive"))
	}
	return errors.Join(errs...)
}

// Same syntax as internal/muninn (section 2).
var (
	reTenant  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	reProject = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
)

// envRef matches ${VAR} and ${VAR:-default}; $${ escapes a literal ${.
var envRef = regexp.MustCompile(`\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}`)

// ExpandEnv is Loki's -config.expand-env syntax (same as rum-api's).
func ExpandEnv(raw []byte, lookup func(string) (string, bool)) []byte {
	return envRef.ReplaceAllFunc(raw, func(m []byte) []byte {
		if string(m) == "$${" {
			return []byte("${")
		}
		sub := envRef.FindSubmatch(m)
		v, _ := lookup(string(sub[1]))
		if v == "" && sub[2] != nil {
			v = string(sub[3])
		}
		return []byte(v)
	})
}
