// Package ouoauthextension is a server authenticator that delegates to
// another one (basicauth/server in ouo, ADR-0007) and counts what it rejects.
//
// confighttp answers an authentication failure with 401 before any receiver
// or pipeline code runs, so the collector's own metrics never see it (QA
// observation R2-3). Receivers point `auth.authenticator` at this extension
// instead of basicauth; every rejected request adds one to
// ouo_auth_failures_total{reason, authenticator}. Successful requests are
// not counted here (otelcol_receiver_accepted_* covers them).
package ouoauthextension // import "github.com/ouo11y/ouo11y/collector/extension/ouoauthextension"
