package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
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
	// DefaultTranslateQueueBytes bounds the bytes waiting for translation.
	DefaultTranslateQueueBytes int64 = 256 << 20
	// DefaultMirrorQueueBytes bounds the bytes waiting for all mirrors together.
	DefaultMirrorQueueBytes int64 = 256 << 20
	// DefaultMirrorTimeout bounds one mirror round trip.
	DefaultMirrorTimeout = 10 * time.Second
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
	// silently drops every sibling key (project/kb-archive/collector-components.md).
	ServerConfig confighttp.ServerConfig `mapstructure:",squash"`

	// UpstreamTimeout bounds one forward to Sentry.
	UpstreamTimeout time.Duration `mapstructure:"upstream_timeout"`
	// MaxTranslateBytes bounds the copy kept for translation.
	MaxTranslateBytes int64 `mapstructure:"max_translate_bytes"`
	// TranslateQueueSize is the bounded queue between forwarding and translation.
	TranslateQueueSize int `mapstructure:"translate_queue_size"`
	// TranslateQueueBytes bounds the bytes held by that queue.
	TranslateQueueBytes int64 `mapstructure:"translate_queue_bytes"`
	// PassthroughUpstream, when set, receives every request the project table
	// does not match (unknown or missing key, unknown project, other ingest
	// endpoints of unknown projects), unchanged and untranslated, instead of
	// the 403 / 404 answer. It is the production Sentry, so that a missing
	// table row never costs an event (spec section 2a).
	PassthroughUpstream string `mapstructure:"passthrough_upstream"`
	// Mirror bounds the asynchronous copies sent to the projects' mirrors.
	Mirror MirrorSettings `mapstructure:"mirror"`
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
	// CopyTags copies the error events' tags as ouo.sentry.tag.<key>. Off by
	// default: tags are app-chosen content (spec section 12).
	CopyTags bool `mapstructure:"copy_tags"`
	// Mirrors get an asynchronous copy of every envelope the bridge answered
	// (spec section 2b). They never change or delay the answer to the SDK.
	Mirrors []MirrorConfig `mapstructure:"mirrors"`
}

// MirrorConfig is one secondary Sentry that gets a copy of a project's envelopes.
type MirrorConfig struct {
	// Name labels the mirror's metrics, next to the project's ouo_project_id
	// (default: the upstream host).
	Name string `mapstructure:"name"`
	// Upstream is the mirror's ingest base URL (scheme://host[:port][/path]).
	Upstream string `mapstructure:"upstream"`
	// SentryProjectID replaces the project id in the path and envelope dsn
	// (default: unchanged).
	SentryProjectID string `mapstructure:"sentry_project_id"`
	// PublicKey replaces sentry_key in X-Sentry-Auth, Authorization, the query
	// string and the envelope dsn (default: unchanged).
	PublicKey string `mapstructure:"public_key"`
}

// MirrorSettings bounds the mirror queues.
type MirrorSettings struct {
	// QueueBytes bounds the bytes waiting for all mirrors together.
	QueueBytes int64 `mapstructure:"queue_bytes"`
	// Timeout bounds one mirror round trip.
	Timeout time.Duration `mapstructure:"timeout"`
}

// StateConfig bounds the correlation state.
type StateConfig struct {
	MaxSessions int           `mapstructure:"max_sessions"`
	TTL         time.Duration `mapstructure:"ttl"`
	ReplayHold  time.Duration `mapstructure:"replay_hold"`
	// LogHold is how long a Sentry log entry, or a user report whose error is not
	// known yet, waits for its session (default 1 min).
	LogHold time.Duration `mapstructure:"log_hold"`
}

var _ component.Config = (*Config)(nil)

// Validate implements component.ConfigValidator.
func (cfg *Config) Validate() error {
	var errs []error
	if cfg.ServerConfig.NetAddr.Endpoint == "" {
		errs = append(errs, errors.New("endpoint must not be empty"))
	}
	if cfg.UpstreamTimeout < 0 || cfg.MaxTranslateBytes < 0 || cfg.TranslateQueueSize < 0 || cfg.TranslateQueueBytes < 0 {
		errs = append(errs, errors.New("upstream_timeout, max_translate_bytes, translate_queue_size and translate_queue_bytes must not be negative"))
	}
	if m := cfg.Mirror; m.QueueBytes < 0 || m.Timeout < 0 {
		errs = append(errs, errors.New("mirror queue_bytes and timeout must not be negative"))
	}
	if cfg.PassthroughUpstream != "" && !validUpstream(cfg.PassthroughUpstream) {
		errs = append(errs, errors.New("passthrough_upstream must be an http(s) base URL without query"))
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
		if p.Upstream != UpstreamNone && !validUpstream(p.Upstream) {
			errs = append(errs, fmt.Errorf("%s: upstream must be an http(s) base URL without query, or %q", where, UpstreamNone))
		}
		names := map[string]bool{}
		for j, m := range p.Mirrors {
			mw := fmt.Sprintf("%s.mirrors[%d]", where, j)
			if !validUpstream(m.Upstream) {
				errs = append(errs, fmt.Errorf("%s: upstream must be an http(s) base URL without query", mw))
				continue
			}
			if m.SentryProjectID != "" && !sentryProjectIDRe.MatchString(m.SentryProjectID) {
				errs = append(errs, fmt.Errorf("%s: sentry_project_id must be numeric", mw))
			}
			if strings.ContainsAny(m.PublicKey, " ,=&@/") {
				errs = append(errs, fmt.Errorf("%s: public_key must be a bare DSN public key", mw))
			}
			if n := mirrorName(m); names[n] {
				errs = append(errs, fmt.Errorf("%s: duplicate mirror name %q", mw, n))
			} else {
				names[n] = true
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

// validUpstream reports whether s is an http(s) base URL without query.
func validUpstream(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.RawQuery == ""
}

// mirrorName is the mirror's metric label.
func mirrorName(m MirrorConfig) string {
	if m.Name != "" {
		return m.Name
	}
	if u, err := url.Parse(m.Upstream); err == nil {
		return u.Host
	}
	return m.Upstream
}
