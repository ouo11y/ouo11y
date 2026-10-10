package httpapi

import (
	"net/http"
	"strings"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/project"
)

// allowedHeaders covers the SDK's OTLP ingest (token, gzip, W3C context),
// the replay upload headers and the read token of plain API calls.
const (
	allowedHeaders = "X-Ouo-Project-Token, Content-Type, Content-Encoding, traceparent, baggage, Authorization, X-Ouo-Session-Id, X-Ouo-Seq, Accept, Accept-Encoding"
	allowedMethods = "GET, POST, DELETE, OPTIONS"
)

// cors answers for an origin when any project allows it (ADR-0007 5: a
// preflight carries no token) or when it is one of the deprecated exact
// CORS_ALLOWED_ORIGINS. A preflight from any other origin is 403 without
// CORS headers; other requests pass through (the handlers then apply the
// per-project Origin check themselves).
func cors(reg *project.Registry, extra []string, next http.Handler) http.Handler {
	extras := map[string]bool{}
	for _, o := range extra {
		extras[strings.TrimSuffix(o, "/")] = true
	}
	allowed := func(origin string) bool {
		return reg.AnyAllowsOrigin(origin) || extras[strings.TrimSuffix(origin, "/")]
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		preflight := r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != ""
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Add("Vary", "Origin")
		if !allowed(origin) {
			if preflight {
				writeError(w, http.StatusForbidden, "origin not allowed")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Methods", allowedMethods)
		h.Set("Access-Control-Allow-Headers", allowedHeaders)
		h.Set("Access-Control-Expose-Headers", "Retry-After, X-Ouo-Replay-Kind")
		h.Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// readAuth enforces OUO_READ_TOKEN on GET and DELETE /v1/* when it is set
// (ADR-0007 6). Preflights, /healthz, /readyz and the ingest routes are not
// behind it.
func readAuth(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method == http.MethodGet || r.Method == http.MethodDelete || r.Method == http.MethodHead) && strings.HasPrefix(r.URL.Path, "/v1/") {
			if !bearerMatches(r.Header.Get("Authorization"), token) {
				w.Header().Set("WWW-Authenticate", `Bearer realm="ouo-rum-api"`)
				writeError(w, http.StatusUnauthorized, "read token required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
