package ouoauthextension

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/open-telemetry/opentelemetry-collector-contrib/extension/basicauthextension"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/confmap"
	"go.opentelemetry.io/collector/extension"
	"go.opentelemetry.io/collector/extension/extensionauth"
	"go.opentelemetry.io/collector/extension/extensiontest"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/ouo11y/ouo11y/collector/extension/ouoauthextension/internal/metadata"
)

type host struct {
	component.Host
	ext map[component.ID]component.Component
}

func (h host) GetExtensions() map[component.ID]component.Component { return h.ext }

func TestConfig(t *testing.T) {
	cfg := createDefaultConfig().(*Config)
	if cfg.Validate() == nil {
		t.Fatal("empty authenticator must not validate")
	}
	if err := confmap.NewFromStringMap(map[string]any{"authenticator": "basicauth/server"}).Unmarshal(cfg); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(); err != nil || cfg.Authenticator != component.MustNewIDWithName("basicauth", "server") {
		t.Fatalf("%v %v", cfg.Authenticator, err)
	}
}

func TestCountsFailuresByReason(t *testing.T) {
	// A real basicauth extension with one project, demo:pt_dev_demo_0000000000000000.
	dir := t.TempDir()
	htpasswd := filepath.Join(dir, "projects.htpasswd")
	if err := os.WriteFile(htpasswd, []byte("demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bf := basicauthextension.NewFactory()
	bcfg := bf.CreateDefaultConfig()
	if err := confmap.NewFromStringMap(map[string]any{"htpasswd": map[string]any{"file": htpasswd}}).Unmarshal(bcfg); err != nil {
		t.Fatal(err)
	}
	bid := component.MustNewIDWithName("basicauth", "server")
	bset := extensiontest.NewNopSettings(bf.Type())
	bset.ID = bid
	basic, err := bf.Create(context.Background(), bset, bcfg)
	if err != nil {
		t.Fatal(err)
	}
	h := host{Host: componenttest.NewNopHost(), ext: map[component.ID]component.Component{bid: basic}}
	if err := basic.Start(context.Background(), h); err != nil {
		t.Fatal(err)
	}

	reader := sdkmetric.NewManualReader()
	set := extensiontest.NewNopSettings(metadata.Type)
	set.ID = component.NewID(metadata.Type)
	set.MeterProvider = sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	cfg := &Config{Authenticator: bid}
	e, err := NewFactory().Create(context.Background(), set, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Start(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	srv := e.(extensionauth.Server)
	basicOf := func(u, p string) map[string][]string {
		return map[string][]string{"Authorization": {"Basic " + base64.StdEncoding.EncodeToString([]byte(u+":"+p))}}
	}
	if _, err := srv.Authenticate(context.Background(), basicOf("demo", "pt_dev_demo_0000000000000000")); err != nil {
		t.Fatalf("valid credential rejected: %v", err)
	}
	for _, s := range []map[string][]string{
		{},                                // missing
		{"Authorization": {"Bearer x"}},   // malformed
		basicOf("demo", "wrong"),          // invalid_credentials
		basicOf("nosuchproject", "token"), // invalid_credentials
	} {
		if _, err := srv.Authenticate(context.Background(), s); err == nil {
			t.Fatalf("%v accepted", s)
		}
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "ouo_auth_failures_total" {
				continue
			}
			for _, dp := range m.Data.(metricdata.Sum[int64]).DataPoints {
				r, _ := dp.Attributes.Value("reason")
				a, _ := dp.Attributes.Value("authenticator")
				if a.AsString() != "ouoauth" {
					t.Fatalf("authenticator attribute %q", a.AsString())
				}
				got[r.AsString()] += dp.Value
			}
		}
	}
	want := map[string]int64{ReasonMissing: 1, ReasonMalformed: 1, ReasonInvalidCredentials: 2}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("failures %v, want %v", got, want)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("failures %v, want %v", got, want)
	}
}

func TestStartErrors(t *testing.T) {
	e, err := NewFactory().Create(context.Background(), extensiontest.NewNopSettings(metadata.Type), &Config{Authenticator: component.MustNewID("basicauth")})
	if err != nil {
		t.Fatal(err)
	}
	if e.Start(context.Background(), host{Host: componenttest.NewNopHost(), ext: map[component.ID]component.Component{}}) == nil {
		t.Fatal("missing target must fail Start")
	}
	notAuth := map[component.ID]component.Component{component.MustNewID("basicauth"): extension.Extension(nopExt{})}
	if e.Start(context.Background(), host{Host: componenttest.NewNopHost(), ext: notAuth}) == nil {
		t.Fatal("non-authenticator target must fail Start")
	}
}

type nopExt struct {
	component.StartFunc
	component.ShutdownFunc
}
