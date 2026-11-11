# ADR-0019 React Native SDK: keep the OpenTelemetry JS core and extend it, in two steps

Status: proposed (2026-11-11, React Native SDK session). Decisions 2 and 6 depart from the draft SDK spec and go to the founder with Step 7.

## Context

The founder asked for a full-feature `@ouo11y/react-native`: every must of the Step 5 report, built on OpenTelemetry APIs and SDKs, replay sent as `ouo.replay.chunk` in a pixel and a structure mode on iOS and Android, and no SDK failure ever reaching the host app. The choice was to keep and extend the existing package or to archive it and start again.

Step 5 graded the package (0.3.0) against the [draft SDK spec](../../project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md): 40 of 160 applicable MUSTs met, 50 partly, 70 not met ([audit](../../project/agents/sdk-state/findings/audit-rn.json), [compliance](../../project/kb/client-sdk-state/compliance.md)). Reading the 120 open rows against the code gives four groups:

| Group | Rows | What it needs |
|---|---|---|
| Names and scopes that predate the spec | about 35 (REL-3, REC-1, REC-2, REC-5, most SIG rows, VER-3) | Renames, `ouo.view.id`, scope `ouo.rum`, `schema_url`. No new machinery |
| Layers that do not exist | about 40 (consent, `beforeSend`, URL sanitising, bypass set, drop counting, self-disable, public `shutdown`, reserved names) | New code beside the existing pipeline |
| Rules that differ | about 20 (session id format, activity, restart behaviour, sampling hash, retry and backoff) | Changes inside existing modules |
| Replay over OTLP | about 25 (RPL rows, SMP-10 to SMP-12, SIG-26, SIG-27) | A new chunk envelope and a second format; the capture, masking, disk queue and retry code stay |

What works today and is on OpenTelemetry: the OTel JS logger and tracer providers with batch processors, OTLP/HTTP export through a persisted outbox, fetch and XHR spans, the error handlers, native crash, hang and vitals capture, native pixel replay with masking on both platforms, 212 unit tests and the conformance run in CI. Nothing in the 120 rows needs that code removed.

## Decision

1. **Keep and extend.** The package is not archived. The OTel JS API and SDK stay the core; every new layer is an OTel processor, exporter or a module beside them. The only code retired is the custom replay upload (`/v1/replay/chunks`) once decision 5 lands.
2. **JavaScript owns the session, the telemetry queue and the exporter.** The founder decided on 2026-11-10 that React Native keeps the OTel JS SDK. The draft spec says the opposite (SIG-42: owned by native), written when a native SDK under React Native was assumed. Proposed change for Step 7: SIG-42 becomes "one session and one telemetry queue, owned by one layer; the other layer reads the session id and sampling decision from it". Native keeps what only native can do: crash, hang, app start, frames, replay capture, and the replay queue.
3. **Two steps, because consumers read the wire.** rum-api, the plugin and the CI suites read today's event names and the `event_name` label. A conformant wire breaks them, and they are not this package's to change.
   - **Step A, wire-compatible.** Every must that does not rename a record or change what consumers key on: failure isolation with fault-injection tests, `beforeSend`, consent, URL sanitising, the sampling bypass set, configuration that never throws, drop counting and self-disable, the spec's API surface (old names kept as aliases), public `shutdown`, propagation fixes, transport fixes, truncation. Mergeable on green CI as it is.
   - **Step B, the spec wire.** Names, scope `ouo.rum`, `schema_url`, `ouo.view.id`, session and sampling id rules, protobuf, and replay over OTLP. Built and verified against a fake Collector and the simulators; merged when the Collector maps the new names for the current consumers or the consumers move (decision for the founder, asked 2026-11-11).
4. **Failure isolation is one mechanism, tested by injection.** Every entry point (public API, patched `fetch` and XHR, global handlers, timers, AppState and navigation listeners, processors, exporters, native module methods and callbacks) runs inside one guard that catches, counts and, past `diagnostics.selfDisableThreshold`, turns the SDK into a no-op. A fault-injection suite throws from each seam and asserts the host call still returns what it would without the SDK.
5. **Replay: native capture, native queue, OTLP envelope.**
   - When to look stays as it is: the run loop on iOS, the draw listener on Android.
   - What is recorded is a format adapter (RPL-27) with two implementations: **pixel** (`ouo-frames/3`: masked JPEG frames and tile patches, today's recorder) and **structure** (`ouo-wireframe/1`: the view tree as rectangles with type, colours and text replaced by `***`). Both produce newline-delimited JSON events, so the chunks of a segment concatenate into a valid payload (RPL-7).
   - A chunk is one OTLP/HTTP protobuf request to `/v1/logs` holding one log record: scope `ouo.replay`, event `ouo.replay.chunk`, bytes body compressed by the format layer, attributes of spec 11.3. The native layer encodes it with a small hand-written protobuf writer (one message shape, no dependency) and sends it from its own disk queue, so a replay backlog cannot delay telemetry (TRN-3) and a chunk survives a crash (RPL-15). `ouo.replay.ended` is sent the same way, at stop or at the next launch.
   - Buffer mode keeps the last `replay.bufferSeconds` as whole segments in a ring and sends them when a bypass-set record or `replay.capture()` triggers.
6. **Third-party code.** None is copied in step A. For the structure format the wireframe model follows PostHog's mobile replay (MIT) and Datadog's (Apache-2.0) as described in [vendor-internals](../../project/kb/vendor-internals/index.md); Sentry (MIT) has no wireframe mode, so the founder's preference order starts at Datadog here. Any file taken over keeps its licence header and is listed in the package's `NOTICE`.
7. **`sdk/ios` and `sdk/android` are edited additively.** The package compiles those sources into the app (`scripts/sync-ios.mjs`, `sync-android.mjs`), so React Native replay work lands there. The native SDKs' own public behaviour is not changed by this work.

## Consequences

- No flag day inside the package: step A ships to current users without a backend change.
- Until step B merges, the package is not conformant at `0.1.0-draft`: the name, scope and replay rows stay open and are listed in the agent summary.
- Step B makes React Native replay unreadable by today's rum-api replay sink. It needs the Collector route to Muninn (or an interim route) before it merges.
- The JavaScript layer stays the single place where session and sampling are decided; native reads both through the bridge. A crash before the bridge is up is attributed through the persisted session, as today.
- Two replay formats double the reader work in the plugin. The format id on every chunk (RPL-24) keeps that a reader concern.

## Alternatives considered

- **Archive and rewrite on a native core** (the draft's SIG-42). Rejected: it discards working, tested OTel JS code, contradicts the founder's 2026-11-10 direction, and waits on native SDKs planned for Step 12.
- **One PR with a `wire: mvp | spec` switch.** Rejected for now: two wires in one release double the test matrix; kept as the fallback if the Collector mapping is not wanted.
- **Chunks through the JS exporter.** Rejected: 256 KiB of base64 over the bridge every few seconds, and a crash loses the open chunk.
