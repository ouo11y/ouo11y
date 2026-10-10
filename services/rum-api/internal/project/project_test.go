package project

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMatch(t *testing.T) {
	cases := []struct {
		pattern, origin string
		want            bool
	}{
		// exact
		{"https://shop.example.com", "https://shop.example.com", true},
		{"https://shop.example.com", "https://shop.example.com/", true},
		{"https://shop.example.com/", "https://shop.example.com", true},
		{"https://shop.example.com", "HTTPS://Shop.Example.com", true},
		{"https://shop.example.com", "http://shop.example.com", false},
		{"https://shop.example.com", "https://shop.example.com:8443", false},
		{"https://shop.example.com", "https://shop.example.com:443", true}, // default port folds
		{"http://shop.example.com", "http://shop.example.com:80", true},
		{"https://shop.example.com", "https://evil.shop.example.com", false},
		{"https://shop.example.com", "https://shop.example.com.evil.net", false},
		{"https://shop.example.com:8443", "https://shop.example.com:8443", true},
		{"https://shop.example.com:8443", "https://shop.example.com", false},
		// wildcard port
		{"http://localhost:*", "http://localhost:5173", true},
		{"http://localhost:*", "http://localhost", true},
		{"http://localhost:*", "http://localhost:80", true},
		{"http://localhost:*", "https://localhost:5173", false},
		{"http://localhost:*", "http://localhost.evil:5173", false},
		{"http://127.0.0.1:*", "http://127.0.0.1:3000", true},
		{"http://127.0.0.1:*", "http://127.0.0.2:3000", false},
		// wildcard leading label (exactly one label)
		{"https://*.preview.example.com", "https://pr-12.preview.example.com", true},
		{"https://*.preview.example.com", "https://preview.example.com", false},
		{"https://*.preview.example.com", "https://a.b.preview.example.com", false},
		{"https://*.preview.example.com", "https://pr-12.preview.example.com:8443", false},
		{"https://*.preview.example.com:*", "https://pr-12.preview.example.com:8443", true},
		{"https://*.preview.example.com", "http://pr-12.preview.example.com", false},
		// garbage origins never match
		{"http://localhost:*", "null", false},
		{"http://localhost:*", "", false},
		{"http://localhost:*", "localhost:5173", false},
		{"http://localhost:*", "http://localhost:5173/path", false},
		{"http://localhost:*", "http://user@localhost:5173", false},
		{"http://localhost:*", "http://localhost:abc", false},
		// ipv6
		{"http://[::1]:*", "http://[::1]:5173", true},
		{"http://[::1]:5173", "http://[::1]:5173", true},
		{"http://[::1]:5173", "http://[::1]:5174", false},
	}
	for _, c := range cases {
		if got := Match(c.pattern, c.origin); got != c.want {
			t.Errorf("Match(%q, %q) = %v, want %v", c.pattern, c.origin, got, c.want)
		}
	}
}

func TestParsePatternErrors(t *testing.T) {
	for _, bad := range []string{"", "localhost", "http://", "http://*", "http://*:3000", "http://a*.example.com", "http://*.*.example.com", "http://*.", "http://x/y", "http://a:b"} {
		if _, err := ParsePattern(bad); err == nil {
			t.Errorf("ParsePattern(%q) accepted", bad)
		}
	}
	for _, good := range []string{"http://localhost:*", "https://*.x.y", "https://x.y:8443", "https://x.y/", "http://[::1]:*", "capacitor://localhost"} {
		if _, err := ParsePattern(good); err != nil {
			t.Errorf("ParsePattern(%q): %v", good, err)
		}
	}
}

const sampleYAML = `
projects:
  - id: web-store
    name: Web store
    tokens: [pt_live_1, pt_prev_1]
    allowed_origins: ["https://shop.example.com", "https://*.preview.example.com", "http://localhost:*"]
    rate_limit: { requests_per_second: 500, burst: 2000 }
    max_body_bytes: 4194304
  - id: mobile
    tokens: [pt_live_2]
`

func TestParseYAML(t *testing.T) {
	reg, err := Parse([]byte(sampleYAML))
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.Projects()) != 2 {
		t.Fatalf("projects: %d", len(reg.Projects()))
	}
	p, ok := reg.Lookup("pt_prev_1")
	if !ok || p.ID != "web-store" || p.Name != "Web store" || p.RateLimit == nil || p.RateLimit.RequestsPerSecond != 500 || p.RateLimit.Burst != 2000 || p.MaxBodyBytes != 4194304 {
		t.Fatalf("lookup: %v %+v", ok, p)
	}
	if m, ok := reg.Lookup("pt_live_2"); !ok || m.ID != "mobile" || m.Name != "mobile" || m.RateLimit != nil || m.MaxBodyBytes != 0 {
		t.Fatalf("mobile: %v %+v", ok, m)
	}
	if _, ok := reg.Lookup("nope"); ok {
		t.Fatal("unknown token resolved")
	}
	if _, ok := reg.Lookup(""); ok {
		t.Fatal("empty token resolved")
	}
	if !p.AllowsOrigin("https://pr-1.preview.example.com") || p.AllowsOrigin("https://evil.example") {
		t.Fatal("origins")
	}
	// Preflight question: any project.
	if !reg.AnyAllowsOrigin("http://localhost:5173") || reg.AnyAllowsOrigin("https://evil.example") {
		t.Fatal("any allows")
	}
	// Mobile has no origins at all: a request with no Origin passes elsewhere, but any Origin fails.
	if reg.Projects()[1].AllowsOrigin("http://localhost:5173") {
		t.Fatal("mobile allows localhost")
	}
}

func TestParseYAMLErrors(t *testing.T) {
	cases := map[string]string{
		"empty":           `projects: []`,
		"no id":           "projects:\n  - tokens: [a]\n",
		"no tokens":       "projects:\n  - id: a\n",
		"dup token":       "projects:\n  - id: a\n    tokens: [t]\n  - id: b\n    tokens: [t]\n",
		"dup id":          "projects:\n  - id: a\n    tokens: [t]\n  - id: a\n    tokens: [u]\n",
		"bad origin":      "projects:\n  - id: a\n    tokens: [t]\n    allowed_origins: [\"localhost\"]\n",
		"unknown field":   "projects:\n  - id: a\n    tokens: [t]\n    token: x\n",
		"negative limit":  "projects:\n  - id: a\n    tokens: [t]\n    max_body_bytes: -1\n",
		"negative burst":  "projects:\n  - id: a\n    tokens: [t]\n    rate_limit: {burst: -1}\n",
		"not yaml object": "- a\n",
	}
	for name, y := range cases {
		if _, err := Parse([]byte(y)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projects.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	// File wins over the env fallback.
	reg, err := Load(Source{File: path, Token: "ignored"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reg.Lookup("ignored"); ok || len(reg.Projects()) != 2 {
		t.Fatal("env fallback used although file was set")
	}
	if _, err := Load(Source{File: filepath.Join(dir, "missing.yaml")}); err == nil {
		t.Fatal("missing file accepted")
	}
	// Env fallback.
	reg, err = Load(Source{Token: "pt_dev", AllowedOrigins: []string{"http://localhost:*"}})
	if err != nil {
		t.Fatal(err)
	}
	p, ok := reg.Lookup("pt_dev")
	if !ok || p.ID != "default" || !p.AllowsOrigin("http://localhost:3000") {
		t.Fatalf("env project: %v %+v", ok, p)
	}
	reg, _ = Load(Source{ID: "demo", Token: "pt_dev"})
	if p, _ := reg.Lookup("pt_dev"); p.ID != "demo" || p.AllowsOrigin("http://localhost:3000") {
		t.Fatalf("env project id: %+v", p)
	}
	// Nothing configured: a clear error.
	if _, err := Load(Source{}); err == nil || !strings.Contains(err.Error(), "OUO_PROJECT_TOKEN") {
		t.Fatalf("no project: %v", err)
	}
}
