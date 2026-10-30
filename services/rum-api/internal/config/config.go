// Package config builds the rum-api settings, operated like Loki and Tempo:
// defaults, then an optional YAML file (-config.file, with ${VAR} expansion
// under -config.expand-env), then the environment variables rum-api has always
// read, which override the file so existing deployments keep working.
// config.example.yaml documents every key.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// Storage backends.
const (
	BackendFilesystem = "filesystem"
	BackendS3         = "s3"
)

// Config is the runtime configuration. The comment after each field names
// the environment variable that overrides it.
type Config struct {
	Server    Server    `yaml:"server"`
	Auth      Auth      `yaml:"auth"`
	Loki      Loki      `yaml:"loki"`
	Tempo     Tempo     `yaml:"tempo"`
	Grafana   Grafana   `yaml:"grafana"`
	Session   Session   `yaml:"session"`
	Limits    Limits    `yaml:"limits"`
	Storage   Storage   `yaml:"storage"`
	Retention Retention `yaml:"retention"`
	// SourceMaps tunes symbolication (ADR-0011).
	SourceMaps SourceMaps `yaml:"sourcemaps"`
	// Projects are per-project overrides keyed by project id (the collector's
	// htpasswd user name): replay retention and server-side sampling.
	Projects map[string]Project `yaml:"projects"`
}

// Server is the HTTP listener.
type Server struct {
	HTTPListenAddress  string   `yaml:"http_listen_address"`  // RUM_API_ADDR, default :8080
	CORSAllowedOrigins []string `yaml:"cors_allowed_origins"` // CORS_ALLOWED_ORIGINS, comma separated extra origins
}

// Auth holds the shared secrets of ADR-0007 5. rum-api is internal: the
// collector's replay exporter is the only writer, the Grafana plugin proxy
// the only reader, and an operator the only caller of /v1/admin/*.
type Auth struct {
	IngestToken string `yaml:"ingest_token"` // OUO_INGEST_TOKEN: when set, POST /v1/replay/chunks needs `Authorization: Bearer <token>`
	ReadToken   string `yaml:"read_token"`   // OUO_READ_TOKEN: when set, GET and DELETE /v1/* need `Authorization: Bearer <token>`
	AdminToken  string `yaml:"admin_token"`  // OUO_ADMIN_TOKEN: bearer of /v1/admin/* (deletions, audit, sweep); empty disables the admin API
}

// Backend is a query backend and its Grafana datasource (deep links).
type Backend struct {
	URL           string `yaml:"url"`            // LOKI_URL / TEMPO_URL
	DatasourceUID string `yaml:"datasource_uid"` // GRAFANA_LOKI_DATASOURCE_UID / GRAFANA_TEMPO_DATASOURCE_UID
}

// Loki adds the delete API switch and the funnel cache.
type Loki struct {
	Backend `yaml:",inline"`
	// DeleteAPI submits a Loki delete request (POST /loki/api/v1/delete) for
	// every user or project deletion. Needs the compactor with retention and a
	// delete request store (docs/operations/data-lifecycle.md).
	DeleteAPI bool `yaml:"delete_api"` // LOKI_DELETE_API, default true
	// FunnelCacheTTL caches funnel results per definition, filters and
	// range (docs/specs/funnels.md); 0 disables the cache.
	FunnelCacheTTL time.Duration `yaml:"funnel_cache_ttl"` // LOKI_FUNNEL_CACHE_TTL, default 60s
}

// Tempo adds the search fan-out settings.
type Tempo struct {
	Backend     `yaml:",inline"`
	Concurrency int           `yaml:"concurrency"` // TEMPO_CONCURRENCY, default 8
	CacheTTL    time.Duration `yaml:"cache_ttl"`   // TEMPO_CACHE_TTL, default 60s
}

// Grafana is the browser-facing Grafana used in deep links.
type Grafana struct {
	URL string `yaml:"url"` // GRAFANA_URL, default http://localhost:3000
}

// Session is the server-side session model (docs/specs/session-lifecycle.md).
type Session struct {
	Inactivity     time.Duration `yaml:"inactivity"`      // SESSION_INACTIVITY, default 30m
	MaxDuration    time.Duration `yaml:"max_duration"`    // SESSION_MAX_DURATION, default 4h (also the Loki lookback for the list)
	DetailLookback time.Duration `yaml:"detail_lookback"` // SESSION_DETAIL_LOOKBACK, default 168h: how far back GET /v1/sessions/{id} searches Loki
}

// Limits are the replay chunk size limits in bytes.
type Limits struct {
	MaxChunkBytes      int64 `yaml:"max_chunk_bytes"`       // MAX_CHUNK_BYTES, default 4 MiB (decompressed, rrweb chunks)
	MaxFrameChunkBytes int64 `yaml:"max_frame_chunk_bytes"` // MAX_FRAME_CHUNK_BYTES, default 8 MiB (decompressed, kind frames chunks)
	MaxVideoChunkBytes int64 `yaml:"max_video_chunk_bytes"` // MAX_VIDEO_CHUNK_BYTES, default 8 MiB (decoded mp4 of one kind video chunk), never below MaxChunkBytes
	MaxSourceMapBytes  int64 `yaml:"max_sourcemap_bytes"`   // MAX_SOURCEMAP_BYTES, default 64 MiB (one decompressed source map)
	MaxDSYMBytes       int64 `yaml:"max_dsym_bytes"`        // MAX_DSYM_BYTES, default 512 MiB (one dSYM DWARF file, all slices)
}

// SourceMaps is the parsed-map cache of the symbolicator (ADR-0011 4).
type SourceMaps struct {
	CacheEntries int           `yaml:"cache_entries"` // SOURCEMAP_CACHE_ENTRIES, default 128 parsed maps and dSYMs
	CacheBytes   int64         `yaml:"cache_bytes"`   // SOURCEMAP_CACHE_BYTES, default 512 MiB: their decompressed size together
	CacheTTL     time.Duration `yaml:"cache_ttl"`     // SOURCEMAP_CACHE_TTL, default 10m: other replicas see a re-upload after it
}

// Retention is how long replays are kept and what deletions search
// (docs/operations/data-lifecycle.md). Loki, Tempo and Mimir enforce their own
// TTLs; the deployment renders all four from one values entry.
type Retention struct {
	// Replays is the default replay retention, measured from a session's
	// last stored chunk. 0 keeps replays forever.
	Replays time.Duration `yaml:"replays"` // REPLAY_RETENTION, default 720h
	// Logs is Loki's retention: how far back a delete-by-user looks for the
	// user's sessions.
	Logs time.Duration `yaml:"logs"` // LOG_RETENTION, default 720h
	// SweepInterval is how often the sweeper deletes expired replays (both
	// backends; on S3 it backs up the bucket lifecycle rules and covers
	// per-project values below one day). 0 disables the sweeper.
	SweepInterval time.Duration `yaml:"sweep_interval"` // REPLAY_SWEEP_INTERVAL, default 1h
	// OrphanGrace is how old a session directory without meta.json (an
	// interrupted upload or delete) must be before the sweeper removes it.
	OrphanGrace time.Duration `yaml:"orphan_grace"` // default 1h
	// SourceMaps is how long an uploaded source map is kept, from its upload
	// (a re-upload restarts it). Keep it at least Logs. 0 keeps maps forever.
	SourceMaps time.Duration `yaml:"sourcemaps"` // SOURCEMAP_RETENTION, default 2160h
}

// Project is one project's overrides.
type Project struct {
	Retention ProjectRetention `yaml:"retention"`
	Sampling  Sampling         `yaml:"sampling"`
	// UploadToken is the project's secret source-map upload token (ADR-0011
	// 3), a CI secret; never the public ingest token. Empty: no uploads.
	UploadToken string `yaml:"upload_token"` // OUO_UPLOAD_TOKENS=<project>:<token>,...
}

// ProjectRetention overrides retention.replays for one project (0 or absent:
// the default).
type ProjectRetention struct {
	Replays    time.Duration `yaml:"replays"`
	SourceMaps time.Duration `yaml:"sourcemaps"`
}

// Sampling is the server-side per-project cap on replays (absent: 1). The
// replay sink drops chunks of sessions outside the sample with the SDKs'
// deterministic rule (sampling.Sampled), so a cap below the SDK rate keeps a
// subset of the SDK's sample. A session in the session sample keeps its
// replay when it passes replay_rate (salt replay) or replay_on_error_rate
// (salt replay_on_error, the SDKs' error-triggered replays).
type Sampling struct {
	SessionRate       *float64 `yaml:"session_rate"`
	ReplayRate        *float64 `yaml:"replay_rate"`
	ReplayOnErrorRate *float64 `yaml:"replay_on_error_rate"`
}

// Storage selects the replay store.
type Storage struct {
	Backend    string     `yaml:"backend"` // STORAGE_BACKEND: filesystem (default) or s3
	Filesystem Filesystem `yaml:"filesystem"`
	S3         S3         `yaml:"s3"`
}

// Filesystem is the local replay store: <dir>/replays/<session>/...
type Filesystem struct {
	Dir string `yaml:"dir"` // DATA_DIR, default /data
}

// S3 is an S3 compatible bucket (AWS S3, MinIO, ...). Keys are
// <prefix>/replays/<session>/..., the filesystem layout.
type S3 struct {
	Endpoint string `yaml:"endpoint"` // S3_ENDPOINT: host[:port], no scheme; default s3.<region>.amazonaws.com
	Bucket   string `yaml:"bucket"`   // S3_BUCKET (required)
	Region   string `yaml:"region"`   // S3_REGION, default us-east-1
	// Static credentials. Both empty: the AWS environment, shared files and
	// instance / pod role (IRSA) chain.
	AccessKeyID     string `yaml:"access_key_id"`     // S3_ACCESS_KEY_ID
	SecretAccessKey string `yaml:"secret_access_key"` // S3_SECRET_ACCESS_KEY
	SessionToken    string `yaml:"session_token"`     // S3_SESSION_TOKEN
	// Insecure talks plain HTTP (local MinIO); InsecureSkipVerify keeps TLS
	// but trusts any certificate.
	Insecure           bool   `yaml:"insecure"`             // S3_INSECURE
	InsecureSkipVerify bool   `yaml:"insecure_skip_verify"` // S3_INSECURE_SKIP_VERIFY
	ForcePathStyle     bool   `yaml:"force_path_style"`     // S3_FORCE_PATH_STYLE: bucket in the path (MinIO) instead of the host name
	Prefix             string `yaml:"prefix"`               // S3_PREFIX: optional key prefix, e.g. a tenant or environment
	// LifecycleRules makes rum-api own the bucket's `ouo-replays-*`
	// lifecycle rules: one expiration rule per retention in use, matching
	// the `ouo-retention` tag rum-api puts on every replay object. Needs
	// s3:GetLifecycleConfiguration and s3:PutLifecycleConfiguration.
	LifecycleRules bool `yaml:"lifecycle_rules"` // S3_LIFECYCLE_RULES, default false
}

// Defaults returns the configuration used when neither a file nor an
// environment variable sets a key.
func Defaults() Config {
	return Config{
		Server:     Server{HTTPListenAddress: ":8080"},
		Loki:       Loki{Backend: Backend{URL: "http://loki:3100", DatasourceUID: "loki"}, DeleteAPI: true, FunnelCacheTTL: 60 * time.Second},
		Tempo:      Tempo{Backend: Backend{URL: "http://tempo:3200", DatasourceUID: "tempo"}, Concurrency: 8, CacheTTL: 60 * time.Second},
		Grafana:    Grafana{URL: "http://localhost:3000"},
		Session:    Session{Inactivity: 30 * time.Minute, MaxDuration: 4 * time.Hour, DetailLookback: 168 * time.Hour},
		Limits:     Limits{MaxChunkBytes: 4 << 20, MaxFrameChunkBytes: 8 << 20, MaxVideoChunkBytes: 8 << 20, MaxSourceMapBytes: 64 << 20, MaxDSYMBytes: 512 << 20},
		Storage:    Storage{Backend: BackendFilesystem, Filesystem: Filesystem{Dir: "/data"}, S3: S3{Region: "us-east-1"}},
		Retention:  Retention{Replays: 720 * time.Hour, Logs: 720 * time.Hour, SweepInterval: time.Hour, OrphanGrace: time.Hour, SourceMaps: 2160 * time.Hour},
		SourceMaps: SourceMaps{CacheEntries: 128, CacheBytes: 512 << 20, CacheTTL: 10 * time.Minute},
	}
}

// FromEnv builds the config from defaults and environment variables only.
func FromEnv() (Config, error) { return Load("", false, os.LookupEnv) }

// Load builds the config: defaults, then the YAML file at path (skipped when
// empty; ${VAR} references expanded when expandEnv), then the environment
// variables, then validation. lookup reads the environment (os.LookupEnv).
func Load(path string, expandEnv bool, lookup func(string) (string, bool)) (Config, error) {
	c := Defaults()
	if path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return c, fmt.Errorf("read config file: %w", err)
		}
		if err := c.parseYAML(raw, expandEnv, lookup); err != nil {
			return c, fmt.Errorf("%s: %w", path, err)
		}
	}
	if err := c.applyEnv(lookup); err != nil {
		return c, err
	}
	c.normalize()
	return c, c.Validate()
}

func (c *Config) parseYAML(raw []byte, expandEnv bool, lookup func(string) (string, bool)) error {
	if expandEnv {
		raw = ExpandEnv(raw, lookup)
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true) // a typo is an error, not a silently ignored key
	if err := dec.Decode(c); err != nil && !errors.Is(err, io.EOF) /* empty file */ {
		return err
	}
	return nil
}

// projectIDRe is the project id syntax the replay sink accepts.
var projectIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// envRef matches ${VAR} and ${VAR:-default}; $${ escapes a literal ${.
var envRef = regexp.MustCompile(`\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}`)

// ExpandEnv replaces ${VAR} with the variable's value and ${VAR:-default}
// with the value or, when unset or empty, default (Loki's
// -config.expand-env syntax). A bare $VAR and a lone $ stay as they are, so
// secrets containing $ survive; $${ is a literal ${. An unset variable
// without a default expands to the empty string.
func ExpandEnv(raw []byte, lookup func(string) (string, bool)) []byte {
	if lookup == nil {
		lookup = os.LookupEnv
	}
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

// applyEnv overrides the file with the environment variables rum-api reads
// since Phase 3 (and the storage ones added with the S3 store). A variable
// set to the empty string is treated as unset, as before.
func (c *Config) applyEnv(lookup func(string) (string, bool)) error {
	get := func(k string) (string, bool) {
		v, ok := lookup(k)
		return v, ok && v != ""
	}
	str := func(k string, dst *string) {
		if v, ok := get(k); ok {
			*dst = v
		}
	}
	var errs []error
	dur := func(k string, dst *time.Duration) {
		if v, ok := get(k); ok {
			d, err := time.ParseDuration(v)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", k, err))
				return
			}
			*dst = d
		}
	}
	i64 := func(k string, dst *int64) {
		if v, ok := get(k); ok {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", k, err))
				return
			}
			*dst = n
		}
	}
	boolean := func(k string, dst *bool) {
		if v, ok := get(k); ok {
			b, err := strconv.ParseBool(v)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", k, err))
				return
			}
			*dst = b
		}
	}

	str("RUM_API_ADDR", &c.Server.HTTPListenAddress)
	if v, ok := get("CORS_ALLOWED_ORIGINS"); ok {
		c.Server.CORSAllowedOrigins = strings.Split(v, ",")
	}
	str("OUO_INGEST_TOKEN", &c.Auth.IngestToken)
	str("OUO_READ_TOKEN", &c.Auth.ReadToken)
	str("OUO_ADMIN_TOKEN", &c.Auth.AdminToken)
	str("LOKI_URL", &c.Loki.URL)
	boolean("LOKI_DELETE_API", &c.Loki.DeleteAPI)
	dur("LOKI_FUNNEL_CACHE_TTL", &c.Loki.FunnelCacheTTL)
	str("GRAFANA_LOKI_DATASOURCE_UID", &c.Loki.DatasourceUID)
	str("TEMPO_URL", &c.Tempo.URL)
	str("GRAFANA_TEMPO_DATASOURCE_UID", &c.Tempo.DatasourceUID)
	if v, ok := get("TEMPO_CONCURRENCY"); ok {
		n, err := strconv.Atoi(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("TEMPO_CONCURRENCY: %w", err))
		} else {
			c.Tempo.Concurrency = n
		}
	}
	dur("TEMPO_CACHE_TTL", &c.Tempo.CacheTTL)
	str("GRAFANA_URL", &c.Grafana.URL)
	dur("SESSION_INACTIVITY", &c.Session.Inactivity)
	dur("SESSION_MAX_DURATION", &c.Session.MaxDuration)
	dur("SESSION_DETAIL_LOOKBACK", &c.Session.DetailLookback)
	i64("MAX_CHUNK_BYTES", &c.Limits.MaxChunkBytes)
	i64("MAX_FRAME_CHUNK_BYTES", &c.Limits.MaxFrameChunkBytes)
	i64("MAX_VIDEO_CHUNK_BYTES", &c.Limits.MaxVideoChunkBytes)

	str("STORAGE_BACKEND", &c.Storage.Backend)
	str("DATA_DIR", &c.Storage.Filesystem.Dir)
	s3 := &c.Storage.S3
	str("S3_ENDPOINT", &s3.Endpoint)
	str("S3_BUCKET", &s3.Bucket)
	str("S3_REGION", &s3.Region)
	str("S3_ACCESS_KEY_ID", &s3.AccessKeyID)
	str("S3_SECRET_ACCESS_KEY", &s3.SecretAccessKey)
	str("S3_SESSION_TOKEN", &s3.SessionToken)
	boolean("S3_INSECURE", &s3.Insecure)
	boolean("S3_INSECURE_SKIP_VERIFY", &s3.InsecureSkipVerify)
	boolean("S3_FORCE_PATH_STYLE", &s3.ForcePathStyle)
	str("S3_PREFIX", &s3.Prefix)
	boolean("S3_LIFECYCLE_RULES", &s3.LifecycleRules)
	dur("REPLAY_RETENTION", &c.Retention.Replays)
	dur("LOG_RETENTION", &c.Retention.Logs)
	dur("REPLAY_SWEEP_INTERVAL", &c.Retention.SweepInterval)
	dur("SOURCEMAP_RETENTION", &c.Retention.SourceMaps)
	i64("MAX_SOURCEMAP_BYTES", &c.Limits.MaxSourceMapBytes)
	i64("MAX_DSYM_BYTES", &c.Limits.MaxDSYMBytes)
	i64("SOURCEMAP_CACHE_BYTES", &c.SourceMaps.CacheBytes)
	dur("SOURCEMAP_CACHE_TTL", &c.SourceMaps.CacheTTL)
	if v, ok := get("SOURCEMAP_CACHE_ENTRIES"); ok {
		n, err := strconv.Atoi(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("SOURCEMAP_CACHE_ENTRIES: %w", err))
		} else {
			c.SourceMaps.CacheEntries = n
		}
	}
	// OUO_UPLOAD_TOKENS=web-store:ut_...,shop:ut_... sets projects.<id>.upload_token.
	if v, ok := get("OUO_UPLOAD_TOKENS"); ok {
		for _, pair := range strings.Split(v, ",") {
			id, tok, ok := strings.Cut(strings.TrimSpace(pair), ":")
			if !ok || id == "" || tok == "" {
				errs = append(errs, fmt.Errorf("OUO_UPLOAD_TOKENS: %q is not <project>:<token>", pair))
				continue
			}
			if c.Projects == nil {
				c.Projects = map[string]Project{}
			}
			p := c.Projects[id]
			p.UploadToken = tok
			c.Projects[id] = p
		}
	}
	return errors.Join(errs...)
}

// normalize trims list entries and derives dependent limits.
func (c *Config) normalize() {
	var origins []string
	for _, o := range c.Server.CORSAllowedOrigins {
		if o = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(o), "/")); o != "" {
			origins = append(origins, o)
		}
	}
	c.Server.CORSAllowedOrigins = origins
	c.Storage.Backend = strings.ToLower(strings.TrimSpace(c.Storage.Backend))
	c.Storage.S3.Prefix = strings.Trim(c.Storage.S3.Prefix, "/")
	// The frames and video limits are never below the rrweb limit.
	c.Limits.MaxFrameChunkBytes = max(c.Limits.MaxFrameChunkBytes, c.Limits.MaxChunkBytes)
	c.Limits.MaxVideoChunkBytes = max(c.Limits.MaxVideoChunkBytes, c.Limits.MaxChunkBytes)
}

// Validate reports every invalid setting at once.
func (c Config) Validate() error {
	var errs []error
	bad := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if c.Server.HTTPListenAddress == "" {
		bad("server.http_listen_address is empty")
	}
	for name, u := range map[string]string{"loki.url": c.Loki.URL, "tempo.url": c.Tempo.URL, "grafana.url": c.Grafana.URL} {
		if p, err := url.Parse(u); err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
			bad("%s %q is not an http(s) URL", name, u)
		}
	}
	if c.Tempo.Concurrency < 1 {
		bad("tempo.concurrency must be at least 1")
	}
	for name, d := range map[string]time.Duration{"tempo.cache_ttl": c.Tempo.CacheTTL, "loki.funnel_cache_ttl": c.Loki.FunnelCacheTTL, "session.inactivity": c.Session.Inactivity,
		"session.max_duration": c.Session.MaxDuration, "session.detail_lookback": c.Session.DetailLookback} {
		if d < 0 || (d == 0 && !strings.HasSuffix(name, "cache_ttl")) {
			bad("%s must be positive", name)
		}
	}
	if c.Limits.MaxSourceMapBytes <= 0 {
		bad("limits.max_sourcemap_bytes must be positive")
	}
	if c.Limits.MaxDSYMBytes <= 0 {
		bad("limits.max_dsym_bytes must be positive")
	}
	if c.SourceMaps.CacheBytes <= 0 {
		bad("sourcemaps.cache_bytes must be positive")
	}
	if c.SourceMaps.CacheEntries < 1 {
		bad("sourcemaps.cache_entries must be at least 1")
	}
	if c.Limits.MaxChunkBytes <= 0 {
		bad("limits.max_chunk_bytes must be positive")
	}
	for name, d := range map[string]time.Duration{"retention.replays": c.Retention.Replays, "retention.logs": c.Retention.Logs,
		"retention.sweep_interval": c.Retention.SweepInterval, "retention.orphan_grace": c.Retention.OrphanGrace,
		"retention.sourcemaps": c.Retention.SourceMaps, "sourcemaps.cache_ttl": c.SourceMaps.CacheTTL} {
		if d < 0 {
			bad("%s must not be negative", name)
		}
	}
	for id, p := range c.Projects {
		if !projectIDRe.MatchString(id) {
			bad("projects: %q is not a project id", id)
		}
		if p.Retention.Replays < 0 {
			bad("projects.%s.retention.replays must not be negative", id)
		}
		if p.Retention.SourceMaps < 0 {
			bad("projects.%s.retention.sourcemaps must not be negative", id)
		}
		if p.UploadToken != "" && len(p.UploadToken) < 16 {
			bad("projects.%s.upload_token must be at least 16 characters", id)
		}
		for name, r := range map[string]*float64{"session_rate": p.Sampling.SessionRate, "replay_rate": p.Sampling.ReplayRate,
			"replay_on_error_rate": p.Sampling.ReplayOnErrorRate} {
			if r != nil && (*r < 0 || *r > 1) {
				bad("projects.%s.sampling.%s must be between 0 and 1", id, name)
			}
		}
	}
	switch c.Storage.Backend {
	case BackendFilesystem:
		if c.Storage.Filesystem.Dir == "" {
			bad("storage.filesystem.dir is empty")
		}
	case BackendS3:
		s3 := c.Storage.S3
		if s3.Bucket == "" {
			bad("storage.s3.bucket is required with storage.backend s3")
		}
		if strings.Contains(s3.Endpoint, "://") || strings.Contains(s3.Endpoint, "/") {
			bad("storage.s3.endpoint %q must be host[:port] without scheme or path (TLS is storage.s3.insecure)", s3.Endpoint)
		}
		if (s3.AccessKeyID == "") != (s3.SecretAccessKey == "") {
			bad("storage.s3.access_key_id and storage.s3.secret_access_key must be set together")
		}
	default:
		bad("storage.backend %q must be %s or %s", c.Storage.Backend, BackendFilesystem, BackendS3)
	}
	return errors.Join(errs...)
}

// Redacted returns a copy with secrets replaced, for -config.verify and logs.
func (c Config) Redacted() Config {
	mask := func(s *string) {
		if *s != "" {
			*s = "<redacted>"
		}
	}
	mask(&c.Auth.IngestToken)
	mask(&c.Auth.ReadToken)
	mask(&c.Auth.AdminToken)
	mask(&c.Storage.S3.SecretAccessKey)
	mask(&c.Storage.S3.SessionToken)
	if len(c.Projects) > 0 {
		projects := make(map[string]Project, len(c.Projects))
		for id, p := range c.Projects {
			mask(&p.UploadToken)
			projects[id] = p
		}
		c.Projects = projects
	}
	return c
}

// Warnings are valid but risky settings, logged at start-up and by -config.verify.
func (c Config) Warnings() []string {
	var out []string
	short := func(name string, maps time.Duration) {
		if maps > 0 && (c.Retention.Logs == 0 || maps < c.Retention.Logs) {
			out = append(out, fmt.Sprintf("%s (%s) is shorter than retention.logs (%s): older errors lose their source maps", name, maps, c.Retention.Logs))
		}
	}
	short("retention.sourcemaps", c.Retention.SourceMaps)
	for id, p := range c.Projects {
		short("projects."+id+".retention.sourcemaps", p.Retention.SourceMaps)
	}
	return out
}

// YAML renders the config in the file format.
func (c Config) YAML() ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(c); err != nil {
		return nil, err
	}
	return buf.Bytes(), enc.Close()
}
