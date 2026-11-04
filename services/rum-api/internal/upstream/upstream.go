// Package upstream adds the per-backend request headers (X-Scope-OrgID,
// extra headers, basic auth) to every call rum-api makes to Loki or Tempo,
// for an existing, shared stack (docs/operations/existing-lgtm.md).
package upstream

import "net/http"

// Transport sets Headers on every request it sends through Base.
type Transport struct {
	Base    http.RoundTripper // nil: http.DefaultTransport
	Headers http.Header
}

// RoundTrip clones the request (a RoundTripper must not modify it) and sets
// the headers, replacing any value the caller set.
func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	if len(t.Headers) == 0 {
		return base.RoundTrip(req)
	}
	r := req.Clone(req.Context())
	for k, v := range t.Headers {
		r.Header[k] = append([]string(nil), v...)
	}
	return base.RoundTrip(r)
}

// Client returns c with its transport wrapped so every request carries
// headers; c itself is not modified. No headers: c unchanged.
func Client(c *http.Client, headers http.Header) *http.Client {
	if len(headers) == 0 {
		return c
	}
	out := *c
	out.Transport = &Transport{Base: c.Transport, Headers: headers.Clone()}
	return &out
}
