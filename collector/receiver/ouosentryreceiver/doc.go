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
//
// Session resolution keeps its state in memory (sessionState, the replay and
// log hold queues), so the receiver must run as exactly one replica: with two,
// each sees part of every device's envelopes and items lose their session,
// replay segments are dropped as unresolved and error counts are inflated.
// Operator guide: docs/sentry-bridge-deployment.md (checklist N4).
package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"
