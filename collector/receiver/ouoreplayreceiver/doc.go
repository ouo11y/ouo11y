// Package ouoreplayreceiver implements the ouo replay receiver (ADR-0007):
// an HTTP endpoint, POST /v1/replay/chunks, built on confighttp so it shares
// the authenticator, CORS, TLS, decompression and body-size options of the
// OTLP receiver. Every accepted chunk becomes one log record whose body is
// the decompressed chunk JSON, stamped with the authenticated project id.
package ouoreplayreceiver // import "github.com/ZiadMansourM/ouo/collector/receiver/ouoreplayreceiver"
