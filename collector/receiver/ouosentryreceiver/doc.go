// Package ouosentryreceiver implements the Sentry SDK bridge (ADR-0008,
// docs/specs/sentry-bridge.md): an HTTP endpoint that speaks Sentry's
// envelope ingest protocol, POST /api/{project_id}/envelope/.
//
// Every authenticated request is forwarded byte for byte to the project's
// upstream Sentry and the upstream answer is returned to the SDK unchanged,
// so the SDK behaves as if it talked to Sentry directly. Envelopes the
// upstream accepted are then translated, off the request path, into ouo
// telemetry: logs and traces for the normal pipelines, replay chunks for the
// replay pipeline.
package ouosentryreceiver // import "github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver"
