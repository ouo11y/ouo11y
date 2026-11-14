package config

import (
	"strings"
	"testing"
)

func TestUploadTokenValidation(t *testing.T) {
	cases := map[string]struct {
		mt     bool
		tokens []UploadToken
		want   string
	}{
		"ok":            {tokens: []UploadToken{{Project: "shop", Token: "a"}, {Project: "web", Token: "b"}}},
		"bad project":   {tokens: []UploadToken{{Project: "Shop!", Token: "a"}}, want: "not a project id"},
		"empty token":   {tokens: []UploadToken{{Project: "shop"}}, want: "token is empty"},
		"reused token":  {tokens: []UploadToken{{Project: "shop", Token: "a"}, {Project: "web", Token: "a"}}, want: "used twice"},
		"tenant needed": {mt: true, tokens: []UploadToken{{Project: "shop", Token: "a"}}, want: "not a tenant id"},
		"tenant given":  {mt: true, tokens: []UploadToken{{Project: "shop", Tenant: "acme", Token: "a"}}},
	}
	for name, c := range cases {
		cfg := Defaults()
		cfg.MultitenancyEnabled = c.mt
		cfg.DebugFiles.UploadTokens = c.tokens
		err := cfg.Validate()
		if c.want == "" && err != nil || c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)) {
			t.Errorf("%s: %v, want %q", name, err, c.want)
		}
	}
}

func TestDebugFileDefaults(t *testing.T) {
	d := Defaults().DebugFiles
	if d.MaxBytesFor("sourcemap") != 64<<20 || d.MaxBytesFor("dsym") != 512<<20 || d.MaxBytesFor("elf") != 0 {
		t.Fatal("max bytes")
	}
	if d.RetentionFor("x").Hours() != 8760 {
		t.Fatal("retention")
	}
}

func TestTokensDistinct(t *testing.T) {
	cfg := Defaults()
	cfg.Auth.ReadToken, cfg.Auth.AdminToken = "r", "r"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "admin_token must differ") {
		t.Errorf("admin = read: %v", err)
	}
	cfg.Auth.AdminToken = "a"
	cfg.DebugFiles.UploadTokens = []UploadToken{{Project: "shop", Token: "a"}}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "equal to an auth token") {
		t.Errorf("upload = admin: %v", err)
	}
	cfg.DebugFiles.UploadTokens[0].Token = "u"
	if err := cfg.Validate(); err != nil {
		t.Error(err)
	}
}
