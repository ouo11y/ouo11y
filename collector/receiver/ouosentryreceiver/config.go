package ouosentryreceiver // import "github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver"

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/confighttp"
)

const (
	// DefaultEndpoint is the listen address when `endpoint` is not set.
	DefaultEndpoint = "0.0.0.0:4320"
	// DefaultMaxRequestBodySize bounds the raw (still compressed) request
	// body. Sentry's own ingest takes envelopes up to 200 MiB; 100 MiB keeps
	// every realistic mobile envelope (replay segments are tens of KB)
	// transparent while bounding memory.
	DefaultMaxRequestBodySize int64 = 100 << 20
	// DefaultMaxTranslateBytes bounds how much of a body is buffered for
	// translation. Larger envelopes are still forwarded, just not translated.
	DefaultMaxTranslateBytes int64 = 20 << 20
	// DefaultUpstreamTimeout bounds one upstream round trip.
	DefaultUpstreamTimeout = 30 * time.Second
	// DefaultTranslateQueueSize is the number of envelopes waiting for translation.
	DefaultTranslateQueueSize = 10000
	// UpstreamNone answers locally instead of forwarding (cutover mode).
	UpstreamNone = "none"
)

// ouoProjectIDRe matches the project ids rum-api's replay sink accepts.
var ouoProjectIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// sentryProjectIDRe matches Sentry's numeric project ids.
var sentryProjectIDRe = regexp.MustCompile(`^[0-9]{1,20}$`)

// Config is the receiver configuration. The HTTP server options are the
// standard confighttp ones (endpoint, tls, max_request_body_size, ...).
// compression_algorithms is ignored: the receiver needs the raw bytes to
// forward them unchanged and decompresses only its own copy.
type Config struct {
	// Named field with squash, never an anonymous embedding: an embedded
	// confighttp.ServerConfig promotes its Unmarshal method and confmap then
	// silently drops every sibling key (kb/collector-components.md).
	ServerConfig confighttp.ServerConfig `mapstructure:",squash"`

	// UpstreamTimeout bounds one forward to Sentry.
	UpstreamTimeout time.Duration `mapstructure:"upstream_timeout"`
	// MaxTranslateBytes bounds the copy kept for translation.
	MaxTranslateBytes int64 `mapstructure:"max_translate_bytes"`
	// TranslateQueueSize is the bounded queue between forwarding and translation.
	TranslateQueueSize int `mapstructure:"translate_queue_size"`
	// Projects maps Sentry projects and public keys to upstreams and ouo projects.
	Projects []ProjectConfig `mapstructure:"projects"`
	// State bounds the session correlation state (spec section 8).
	State StateConfig `mapstructure:"state"`

	// prevent unkeyed literal initialization
	_ struct{}
}

// ProjectConfig is one row of the project table (spec section 10).
type ProjectConfig struct {
	// SentryProjectID is the numeric id in the DSN path.
	SentryProjectID string `mapstructure:"sentry_project_id"`
	// PublicKeys are the DSN public keys accepted for this project.
	PublicKeys []string `mapstructure:"public_keys"`
	// Upstream is the Sentry ingest base URL (scheme://host[:port][/path]),
	// or "none" to answer locally.
	Upstream string `mapstructure:"upstream"`
	// OuoProjectID is stamped on everything translated from this project.
	OuoProjectID string `mapstructure:"ouo_project_id"`
	// ServiceName is the service.name of translated telemetry.
	ServiceName string `mapstructure:"service_name"`
	// SentryUIURL is the Sentry web UI base, for links (optional).
	SentryUIURL string `mapstructure:"sentry_ui_url"`
}

// StateConfig bounds the correlation state.
type StateConfig struct {
	MaxSessions int           `mapstructure:"max_sessions"`
	TTL         time.Duration `mapstructure:"ttl"`
	ReplayHold  time.Duration `mapstructure:"replay_hold"`
	// LogHold is how long a Sentry log entry waits for its session (default 1 min).
	LogHold time.Duration `mapstructure:"log_hold"`
}

var _ component.Config = (*Config)(nil)

// Validate implements component.ConfigValidator.
func (cfg *Config) Validate() error {
	var errs []error
	if cfg.ServerConfig.NetAddr.Endpoint == "" {
		errs = append(errs, errors.New("endpoint must not be empty"))
	}
	if cfg.UpstreamTimeout < 0 || cfg.MaxTranslateBytes < 0 || cfg.TranslateQueueSize < 0 {
		errs = append(errs, errors.New("upstream_timeout, max_translate_bytes and translate_queue_size must not be negative"))
	}
	if len(cfg.Projects) == 0 {
		errs = append(errs, errors.New("at least one project is required"))
	}
	seen := map[string]bool{}
	for i, p := range cfg.Projects {
		where := fmt.Sprintf("projects[%d]", i)
		if !sentryProjectIDRe.MatchString(p.SentryProjectID) {
			errs = append(errs, fmt.Errorf("%s: sentry_project_id must be numeric", where))
		}
		if len(p.PublicKeys) == 0 {
			errs = append(errs, fmt.Errorf("%s: public_keys must not be empty", where))
		}
		for _, k := range p.PublicKeys {
			key := p.SentryProjectID + "/" + k
			if k == "" {
				errs = append(errs, fmt.Errorf("%s: empty public key", where))
			} else if seen[key] {
				errs = append(errs, fmt.Errorf("%s: duplicate public key %q for project %s", where, k, p.SentryProjectID))
			}
			seen[key] = true
		}
		if p.Upstream != UpstreamNone {
			u, err := url.Parse(p.Upstream)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" {
				errs = append(errs, fmt.Errorf("%s: upstream must be an http(s) base URL without query, or %q", where, UpstreamNone))
			}
		}
		if !ouoProjectIDRe.MatchString(p.OuoProjectID) {
			errs = append(errs, fmt.Errorf("%s: ouo_project_id must match %s", where, ouoProjectIDRe))
		}
		if p.ServiceName == "" {
			errs = append(errs, fmt.Errorf("%s: service_name must not be empty", where))
		}
	}
	return errors.Join(errs...)
}
