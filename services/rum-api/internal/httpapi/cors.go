package httpapi

import (
	"net/http"
	"strings"
)

// allowedHeaders covers the collector's replay sink headers (project id,
// gzip body, chunk headers, ingest bearer), plain JSON API calls with the
// read token from local tooling or a browser, and range requests for video
// segments. exposedHeaders lets such a caller read the replay kind and the
// range response headers.
const (
	allowedHeaders = "Authorization, Content-Type, Content-Encoding, X-Ouo-Project-Id, X-Ouo-Session-Id, X-Ouo-Seq, Accept, Accept-Encoding, Range"
	allowedMethods = "GET, POST, DELETE, OPTIONS"
	exposedHeaders = "X-Ouo-Replay-Kind, Content-Range, Accept-Ranges"
)

// cors reflects the Origin header for any http://localhost:* or
// http://127.0.0.1:* origin plus the configured extra origins, answers
// preflights with 204, and passes everything else through. rum-api is
// internal (ADR-0007 5): the Grafana plugin reaches it through Grafana's
// server-side proxy, so only local development tooling needs CORS.
func cors(extra []string, next http.Handler) http.Handler {
	extras := map[string]bool{}
	for _, o := range extra {
		extras[strings.TrimSuffix(o, "/")] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (localOrigin(origin) || extras[strings.TrimSuffix(origin, "/")]) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", allowedMethods)
			h.Set("Access-Control-Allow-Headers", allowedHeaders)
			h.Set("Access-Control-Expose-Headers", exposedHeaders)
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// localOrigin reports whether origin is http://localhost[:port] or
// http://127.0.0.1[:port].
func localOrigin(origin string) bool {
	rest, ok := strings.CutPrefix(origin, "http://")
	if !ok {
		return false
	}
	host, port, _ := strings.Cut(rest, ":")
	if host != "localhost" && host != "127.0.0.1" {
		return false
	}
	for _, c := range port {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// readAuth enforces OUO_READ_TOKEN on GET and DELETE /v1/* when it is set
// (ADR-0007 5). Preflights, /healthz, /readyz and the replay sink are not
// behind it, nor /v1/admin/*, which takes the admin token instead.
func readAuth(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		read := r.Method == http.MethodGet || r.Method == http.MethodDelete || r.Method == http.MethodHead ||
			(r.Method == http.MethodPost && r.URL.Path == "/v1/symbolicate")
		if read && strings.HasPrefix(r.URL.Path, "/v1/") && !strings.HasPrefix(r.URL.Path, "/v1/admin/") {
			if !bearerMatches(r.Header.Get("Authorization"), token) {
				w.Header().Set("WWW-Authenticate", `Bearer realm="ouo-rum-api"`)
				writeError(w, http.StatusUnauthorized, "read token required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
