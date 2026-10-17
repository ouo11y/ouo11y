// Package ouoreplayexporter posts replay chunks produced by the ouoreplay
// receiver to rum-api's internal sink, POST /v1/replay/chunks, one HTTP
// request per log record (ADR-0007). It uses exporterhelper for the sending
// queue, retries and timeout.
package ouoreplayexporter // import "github.com/ouo11y/ouo11y/collector/exporter/ouoreplayexporter"
