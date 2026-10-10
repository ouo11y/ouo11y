// Package project is the project registry of ADR-0007: which project a
// public ingest token belongs to, which browser origins may send for it and
// which limits apply. Phase 8a reads a YAML file (OUO_PROJECTS_FILE) or a
// single project from the environment; Phase 11 puts Postgres behind the same
// Registry.
package project

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// RateLimit is a per-project token bucket (requests per second and burst).
// Zero values mean "use the server defaults".
type RateLimit struct {
	RequestsPerSecond float64 `yaml:"requests_per_second" json:"requests_per_second"`
	Burst             int     `yaml:"burst" json:"burst"`
}

// Project is one tenant. ID becomes the resource attribute ouo.project.id.
type Project struct {
	ID             string     `yaml:"id" json:"id"`
	Name           string     `yaml:"name" json:"name"`
	Tokens         []string   `yaml:"tokens" json:"tokens"`
	AllowedOrigins []string   `yaml:"allowed_origins" json:"allowed_origins"`
	RateLimit      *RateLimit `yaml:"rate_limit" json:"rate_limit,omitempty"`
	MaxBodyBytes   int64      `yaml:"max_body_bytes" json:"max_body_bytes,omitempty"`

	patterns []Pattern
}

// AllowsOrigin reports whether a browser Origin matches one of the project's
// allowed origin patterns (see Match).
func (p *Project) AllowsOrigin(origin string) bool {
	o, ok := parseOrigin(origin)
	if !ok {
		return false
	}
	for _, pat := range p.patterns {
		if pat.match(o) {
			return true
		}
	}
	return false
}

// Registry maps tokens to projects.
type Registry struct {
	projects []*Project
	byToken  map[string]*Project
}

// ErrNoProject is returned when nothing is configured.
var ErrNoProject = errors.New("no project configured: set OUO_PROJECTS_FILE or OUO_PROJECT_TOKEN")

// Source is where the registry is read from. File wins when set; otherwise
// the single environment project is used.
type Source struct {
	File           string   // OUO_PROJECTS_FILE
	ID             string   // OUO_PROJECT_ID, default "default"
	Token          string   // OUO_PROJECT_TOKEN
	AllowedOrigins []string // OUO_ALLOWED_ORIGINS, already split
}

// Load builds the registry from a Source.
func Load(src Source) (*Registry, error) {
	if src.File != "" {
		b, err := os.ReadFile(src.File)
		if err != nil {
			return nil, fmt.Errorf("read projects file: %w", err)
		}
		reg, err := Parse(b)
		if err != nil {
			return nil, fmt.Errorf("projects file %s: %w", src.File, err)
		}
		return reg, nil
	}
	if src.Token == "" {
		return nil, ErrNoProject
	}
	id := src.ID
	if id == "" {
		id = "default"
	}
	return New([]*Project{{ID: id, Name: id, Tokens: []string{src.Token}, AllowedOrigins: src.AllowedOrigins}})
}

type file struct {
	Projects []*Project `yaml:"projects"`
}

// Parse reads the YAML registry format of ADR-0007.
func Parse(b []byte) (*Registry, error) {
	var f file
	dec := yaml.NewDecoder(strings.NewReader(string(b)))
	dec.KnownFields(true)
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	return New(f.Projects)
}

// New validates the projects and indexes them by token.
func New(projects []*Project) (*Registry, error) {
	if len(projects) == 0 {
		return nil, ErrNoProject
	}
	reg := &Registry{byToken: map[string]*Project{}}
	ids := map[string]bool{}
	for i, p := range projects {
		if p == nil {
			return nil, fmt.Errorf("projects[%d]: empty entry", i)
		}
		p.ID = strings.TrimSpace(p.ID)
		if p.ID == "" {
			return nil, fmt.Errorf("projects[%d]: id is required", i)
		}
		if ids[p.ID] {
			return nil, fmt.Errorf("project %q: duplicate id", p.ID)
		}
		ids[p.ID] = true
		if p.Name == "" {
			p.Name = p.ID
		}
		if len(p.Tokens) == 0 {
			return nil, fmt.Errorf("project %q: at least one token is required", p.ID)
		}
		for _, t := range p.Tokens {
			t = strings.TrimSpace(t)
			if t == "" {
				return nil, fmt.Errorf("project %q: empty token", p.ID)
			}
			if other, dup := reg.byToken[t]; dup {
				return nil, fmt.Errorf("project %q: token also used by project %q", p.ID, other.ID)
			}
			reg.byToken[t] = p
		}
		if p.RateLimit != nil && (p.RateLimit.RequestsPerSecond < 0 || p.RateLimit.Burst < 0) {
			return nil, fmt.Errorf("project %q: rate_limit must not be negative", p.ID)
		}
		if p.MaxBodyBytes < 0 {
			return nil, fmt.Errorf("project %q: max_body_bytes must not be negative", p.ID)
		}
		p.patterns = p.patterns[:0]
		for _, raw := range p.AllowedOrigins {
			pat, err := ParsePattern(raw)
			if err != nil {
				return nil, fmt.Errorf("project %q: allowed origin %q: %w", p.ID, raw, err)
			}
			p.patterns = append(p.patterns, pat)
		}
		reg.projects = append(reg.projects, p)
	}
	return reg, nil
}

// Lookup returns the project a token belongs to.
func (r *Registry) Lookup(token string) (*Project, bool) {
	if r == nil || token == "" {
		return nil, false
	}
	p, ok := r.byToken[token]
	return p, ok
}

// Projects lists the configured projects in file order.
func (r *Registry) Projects() []*Project {
	if r == nil {
		return nil
	}
	return r.projects
}

// AnyAllowsOrigin is the CORS preflight question: preflights carry no token,
// so an origin is answered when any project allows it.
func (r *Registry) AnyAllowsOrigin(origin string) bool {
	if r == nil {
		return false
	}
	for _, p := range r.projects {
		if p.AllowsOrigin(origin) {
			return true
		}
	}
	return false
}

// origin is a parsed scheme://host[:port]. Scheme and host are lower case;
// default ports (80 for http, 443 for https) are dropped so that
// https://a.example and https://a.example:443 compare equal.
type origin struct {
	scheme, host, port string
}

func parseOrigin(s string) (origin, bool) {
	s = strings.TrimSuffix(strings.TrimSpace(s), "/")
	scheme, rest, ok := strings.Cut(s, "://")
	if !ok || scheme == "" || rest == "" || strings.ContainsAny(rest, "/?#@ ") {
		return origin{}, false
	}
	o := origin{scheme: strings.ToLower(scheme)}
	host, port := rest, ""
	if strings.HasPrefix(rest, "[") { // IPv6 literal
		end := strings.IndexByte(rest, ']')
		if end < 0 {
			return origin{}, false
		}
		host = rest[:end+1]
		if tail := rest[end+1:]; tail != "" {
			if !strings.HasPrefix(tail, ":") {
				return origin{}, false
			}
			port = tail[1:]
		}
	} else if i := strings.LastIndexByte(rest, ':'); i >= 0 {
		host, port = rest[:i], rest[i+1:]
	}
	if host == "" {
		return origin{}, false
	}
	o.host = strings.ToLower(host)
	if port != "" && port != "*" {
		for _, c := range port {
			if c < '0' || c > '9' {
				return origin{}, false
			}
		}
	}
	if (o.scheme == "http" && port == "80") || (o.scheme == "https" && port == "443") {
		port = ""
	}
	o.port = port
	return o, true
}

// pattern is an allowed-origin pattern: scheme://host[:port] where `*` may
// replace the leading host label (https://*.preview.example.com, exactly one
// label) or the port (http://localhost:*). Anything else is exact.
type Pattern struct {
	scheme     string
	host       string // without the leading "*." when wildcardHost
	wildHost   bool
	port       string
	wildPort   bool
	normalized string
}

// ParsePattern validates one allowed-origin pattern.
func ParsePattern(raw string) (Pattern, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Pattern{}, errors.New("empty pattern")
	}
	o, ok := parseOrigin(raw)
	if !ok {
		return Pattern{}, errors.New("expected scheme://host[:port]")
	}
	p := Pattern{scheme: o.scheme, host: o.host, port: o.port, normalized: raw}
	if o.port == "*" {
		p.wildPort, p.port = true, ""
	}
	if o.host == "*" {
		return Pattern{}, errors.New("`*` alone is not a valid host; use `*.example.com`")
	}
	if rest, ok := strings.CutPrefix(o.host, "*."); ok {
		if rest == "" || strings.Contains(rest, "*") {
			return Pattern{}, errors.New("`*` may only replace the leading host label")
		}
		p.wildHost, p.host = true, rest
	} else if strings.Contains(o.host, "*") {
		return Pattern{}, errors.New("`*` may only replace the leading host label")
	}
	return p, nil
}

// String returns the pattern as configured.
func (p Pattern) String() string { return p.normalized }

func (p Pattern) match(o origin) bool {
	if o.scheme != p.scheme {
		return false
	}
	if p.wildHost {
		label, rest, ok := strings.Cut(o.host, ".")
		if !ok || label == "" || rest != p.host {
			return false
		}
	} else if o.host != p.host {
		return false
	}
	if p.wildPort {
		return true
	}
	return o.port == p.port
}

// Match reports whether origin matches pattern; it is the function the
// tests and the CORS layer use. An invalid pattern never matches.
func Match(pat, origin string) bool {
	p, err := ParsePattern(pat)
	if err != nil {
		return false
	}
	o, ok := parseOrigin(origin)
	return ok && p.match(o)
}
