package httpapi

import (
	"net/http"
	"strings"
)

// allowedHeaders covers the SDK's replay upload (gzip body + chunk headers)
// and plain JSON API calls from the Grafana plugin or a browser.
const (
	allowedHeaders = "content-type, content-encoding, x-ouo-session-id, x-ouo-seq, accept, accept-encoding"
	allowedMethods = "GET, POST, DELETE, OPTIONS"
)

// cors reflects the Origin header for any http://localhost:* or
// http://127.0.0.1:* origin plus the configured extra origins, answers
// preflights with 204, and passes everything else through.
func cors(extra []string, next http.Handler) http.Handler {
	extras := map[string]bool{}
	for _, o := range extra {
		extras[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (localOrigin(origin) || extras[origin]) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", allowedMethods)
			h.Set("Access-Control-Allow-Headers", allowedHeaders)
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

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
