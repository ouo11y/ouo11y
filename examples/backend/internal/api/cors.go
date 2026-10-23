package api

import (
	"net/http"
	"os"
	"strings"
)

// allowedHeaders must include traceparent, tracestate and baggage (W3C, the
// ouo SDKs) and sentry-trace (@sentry/* SDKs send it next to traceparent):
// browsers strip any non-safelisted request header the preflight did not
// allow, which would silently break trace correlation (checklist N24).
const (
	allowedHeaders = "content-type, traceparent, tracestate, baggage, sentry-trace, x-user-id"
	allowedMethods = "GET, POST, OPTIONS"
)

// CORS reflects the Origin header for any http://localhost:* or
// http://127.0.0.1:* origin plus the exact origins listed in the
// comma-separated CORS_ALLOWED_ORIGINS env var, answers preflight with 204,
// and passes everything else through untouched.
func CORS(next http.Handler) http.Handler {
	extra := extraOrigins(os.Getenv("CORS_ALLOWED_ORIGINS"))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (originAllowed(origin) || extra[origin]) {
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

func originAllowed(origin string) bool {
	rest, ok := strings.CutPrefix(origin, "http://")
	if !ok {
		return false
	}
	host, port, _ := strings.Cut(rest, ":")
	if host != "localhost" && host != "127.0.0.1" {
		return false
	}
	if port == "" {
		return true
	}
	if strings.ContainsAny(port, "/?#@") {
		return false
	}
	for _, c := range port {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func extraOrigins(csv string) map[string]bool {
	out := map[string]bool{}
	for o := range strings.SplitSeq(csv, ",") {
		if o = strings.TrimSpace(strings.TrimSuffix(o, "/")); o != "" {
			out[o] = true
		}
	}
	return out
}
