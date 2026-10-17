// Package ouoratelimitprocessor is a token-bucket rate limiter for traces,
// metrics and logs (ADR-0007). Every call into the processor (one incoming
// request when the processor runs before `batch`) takes one token from the
// bucket of the authenticated project (`auth.username` in the client
// context) and one from the bucket of the client (its address, or the first
// X-Forwarded-For hop). An empty bucket rejects the request with a gRPC
// ResourceExhausted status carrying RetryInfo, which the OTLP receiver
// answers with HTTP 429 + Retry-After (gRPC RESOURCE_EXHAUSTED for gRPC).
//
// All instances with the same component ID (one per pipeline) share one set
// of buckets, so the rates are per request across signals.
package ouoratelimitprocessor // import "github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor"
