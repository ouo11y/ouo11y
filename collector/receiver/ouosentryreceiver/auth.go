package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"net/http"
	"net/url"
	"strings"
)

// keyFromAuthHeader extracts sentry_key from an `X-Sentry-Auth` (or legacy
// `Authorization`) value of the form `Sentry sentry_key=abc, sentry_version=7, ...`.
func keyFromAuthHeader(v string) string {
	v = strings.TrimSpace(v)
	if len(v) < 7 || !strings.EqualFold(v[:6], "Sentry") {
		return ""
	}
	for _, part := range strings.Split(v[6:], ",") {
		k, val, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && strings.TrimSpace(k) == "sentry_key" {
			return strings.TrimSpace(val)
		}
	}
	return ""
}

// requestKeys returns the public keys carried by the request headers and
// query string (the cheap sources); empty strings when absent.
func requestKeys(r *http.Request) (header, query string) {
	header = keyFromAuthHeader(r.Header.Get("X-Sentry-Auth"))
	if header == "" {
		header = keyFromAuthHeader(r.Header.Get("Authorization"))
	}
	query = r.URL.Query().Get("sentry_key")
	return header, query
}

// keyFromDSN returns the public key of a DSN (https://<key>[:<secret>]@host/<project>).
func keyFromDSN(dsn string) string {
	u, err := url.Parse(dsn)
	if err != nil || u.User == nil {
		return ""
	}
	return u.User.Username()
}
