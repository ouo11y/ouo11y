package ouoauthextension // import "github.com/ouo11y/ouo11y/collector/extension/ouoauthextension"

import (
	"context"
	"fmt"
	"strings"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/extension/extensionauth"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/ouo11y/ouo11y/collector/extension/ouoauthextension/internal/metadata"
)

// Failure reasons (the `reason` attribute).
const (
	ReasonMissing            = "missing"
	ReasonMalformed          = "malformed"
	ReasonInvalidCredentials = "invalid_credentials"
	ReasonOther              = "other"
)

type authenticator struct {
	component.ShutdownFunc

	id       component.ID
	target   component.ID
	failures metric.Int64Counter
	next     extensionauth.Server
}

var _ extensionauth.Server = (*authenticator)(nil)

func newAuthenticator(id component.ID, cfg *Config, set component.TelemetrySettings) (*authenticator, error) {
	failures, err := set.MeterProvider.Meter(metadata.ScopeName).Int64Counter("ouo_auth_failures_total",
		metric.WithDescription("Requests the wrapped authenticator rejected (401 / UNAUTHENTICATED), by reason."),
		metric.WithUnit("{request}"))
	if err != nil {
		return nil, err
	}
	return &authenticator{id: id, target: cfg.Authenticator, failures: failures}, nil
}

// Start resolves the wrapped authenticator. Every extension is created before
// any is started, and receivers (which call Authenticate) start after all
// extensions, so the target is started by the first request.
func (a *authenticator) Start(_ context.Context, host component.Host) error {
	ext, ok := host.GetExtensions()[a.target]
	if !ok {
		return fmt.Errorf("ouoauth: authenticator %q not found (list it under service.extensions)", a.target)
	}
	srv, ok := ext.(extensionauth.Server)
	if !ok {
		return fmt.Errorf("ouoauth: extension %q is not a server authenticator", a.target)
	}
	a.next = srv
	return nil
}

func (a *authenticator) Authenticate(ctx context.Context, sources map[string][]string) (context.Context, error) {
	out, err := a.next.Authenticate(ctx, sources)
	if err != nil {
		a.failures.Add(ctx, 1, metric.WithAttributes(
			attribute.String("reason", reason(err)),
			attribute.String("authenticator", a.id.String())))
	}
	return out, err
}

// reason maps the basicauth errors (contrib extension/internal/basicauth) to
// a small fixed set; anything else is "other", so the attribute never takes
// client-controlled values.
func reason(err error) string {
	switch msg := err.Error(); {
	case strings.Contains(msg, "no basic auth provided"):
		return ReasonMissing
	case strings.Contains(msg, "invalid credentials"):
		return ReasonInvalidCredentials
	case strings.Contains(msg, "invalid authorization"):
		return ReasonMalformed
	default:
		return ReasonOther
	}
}
