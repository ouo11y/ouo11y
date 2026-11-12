# ADR-0021 React Native SDK: keep the OpenTelemetry JS core and extend it, in two steps

Status: proposed (2026-11-11, React Native SDK session; first drafted as ADR-0019, renumbered because the Collector to Muninn ADR holds that number). Decisions 3, 5 and 6 are the founder's (2026-11-11 and 2026-11-12). Decision 2 departs from the draft SDK spec and goes to the founder with Step 7.

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
3. **Spec wire only, in two pull requests.** rum-api, the plugin and the CI suites read the MVP event names and the `event_name` label, so a conformant wire breaks them. The founder decided on 2026-11-11 that the MVP names and the current collector path are MVP-only and will be removed: the SDK emits the spec wire with no compatibility mapping and no `wire` switch, and this package does not edit those consumers. The work is split only to keep each review readable:
   - **Step A**: the layers that do not exist yet: failure isolation with fault-injection tests, `beforeSend`, consent, URL sanitising, the sampling bypass set, configuration that never throws, drop counting and self-disable, the spec's API surface (old names kept as aliases), public `shutdown`, propagation and transport fixes, truncation.
   - **Step B**: names, scope `ouo.rum`, `schema_url`, `ouo.view.id`, session and sampling id rules, protobuf, and replay over OTLP.
   - CI checks that assert the MVP wire against rum-api (`tests/e2e/mobile/conformance.mjs`, `examples/ouo-mobile/scripts/verify.py`) fail once the names change. They are not skipped or edited: each pull request lists the failing jobs and why, and the founder, who alone merges, decides.
4. **Failure isolation is one mechanism, tested by injection.** Every entry point (public API, patched `fetch` and XHR, global handlers, timers, AppState and navigation listeners, processors, exporters, native module methods and callbacks) runs inside one guard that catches, counts and, past `diagnostics.selfDisableThreshold`, turns the SDK into a no-op. A fault-injection suite throws from each seam and asserts the host call still returns what it would without the SDK.
5. **Replay: native capture, native queue, OTLP envelope, one option.**
   - The customer option is one string, `replay.mode`. The format id goes on the wire in `ouo.replay.format`. Every format id ends in `/<n>`, the version of the chunk layout, and is named by what the chunk holds, not by a vendor.

     | `replay.mode` | `ouo.replay.format` | Recorder | Platforms |
     |---|---|---|---|
     | `pixel/frames` (default) | `ouo-frames/3` | ouo's own: masked JPEG frames and tile patches | iOS, Android |
     | `pixel/video` | `ouo-video/1` | Sentry's recorder core: masked frames encoded as H.264 segments | iOS, Android |
     | `structure/wireframe` | `ouo-wireframe/1` | Datadog's Session Replay recorder: the view tree as rectangles, text as `***` | iOS, Android, in its own pull request after pixel works on both |
     | `structure/dom` | `rrweb/2` | rrweb | web only |

   - There is no shorthand: `pixel` or `structure` alone is not valid, and the SDK never picks between frames and video. A value that is not valid on the platform leaves replay off with a warning and never throws. A per-OS choice is the app's code: `Platform.select({ ios: "pixel/video", android: "pixel/frames" })`.
   - Both pixel recorders stay and mask identically from the customer's point of view: the same defaults and the same overrides (`.ouoMask()` / `.ouoUnmask()`, `ouo-mask` / `ouo-unmask`). `pixel/video` does not ship until the screen-transition leak its spike measured (masked text readable for one frame at a push or pop, 2 of 5 runs) is fixed.
   - When to look stays as it is in each recorder: the run loop on iOS, the draw listener on Android.
   - A chunk is one OTLP/HTTP protobuf request to `/v1/logs` holding one log record: scope `ouo.replay`, event `ouo.replay.chunk`, bytes body compressed by the format layer where the format compresses (`ouo.replay.encoding`), attributes of spec 11.3. The native layer encodes it with a small hand-written protobuf writer (one message shape, no dependency) and sends it from its own disk queue, so a replay backlog cannot delay telemetry (TRN-3) and a chunk survives a crash (RPL-15). `ouo.replay.ended` is sent the same way, at stop or at the next launch.
   - Buffer-on-error keeps the last `replay.bufferSeconds` as whole segments in a ring and sends them when a bypass-set record or `replay.capture()` triggers. It is a sampling setting (`replay.bufferRate`), not a value of `replay.mode`.
6. **Third-party code is borrowed, credited and kept in sync by script.** `pixel/video` builds on the Sentry iOS spike (PR #181: 28 files of sentry-cocoa 9.33.0 behind `Seams.swift`, MIT, `sdk/ios/scripts/sentry-core-sync.sh`) and the same approach for sentry-java on Android. `structure/wireframe` borrows Datadog's native Session Replay recorders (Apache-2.0); before its schema is adopted, a short check decides whether PostHog's wireframe-to-rrweb conversion would let one rrweb player serve web and mobile, and the result is recorded in the kb. Every borrowed file keeps its licence header and is listed in `NOTICE`. The hand-written wireframe recorder started on 2026-11-11 is parked; its OTLP envelope, chunking and stream code is kept.
7. **`sdk/ios` and `sdk/android` are edited additively.** The package compiles those sources into the app (`scripts/sync-ios.mjs`, `sync-android.mjs`), so React Native replay work lands there. The native SDKs' own public behaviour is not changed by this work.

## Consequences

- Until step B merges, the package is not conformant at `0.1.0-draft`: the name, scope and replay rows stay open and are listed in the agent summary.
- Step B makes React Native sessions and replay unreadable by today's rum-api and plugin until the Collector route to Muninn and the new read side exist. That is accepted.
- The JavaScript layer stays the single place where session and sampling are decided; native reads both through the bridge. A crash before the bridge is up is attributed through the persisted session, as today.
- Three mobile formats mean three readers in the plugin. The format id on every chunk (RPL-24) keeps that a reader concern.
- Borrowed recorder cores add binary size (the iOS spike measured about 236 KiB before dead-stripping) and an upstream to follow; the sync script fails on drift.

## Alternatives considered

- **Archive and rewrite on a native core** (the draft's SIG-42). Rejected: it discards working, tested OTel JS code, contradicts the founder's 2026-11-10 direction, and waits on native SDKs planned for Step 12.
- **A `wire: mvp | spec` switch, or a Collector mapping back to MVP names.** Rejected by the founder: the MVP wire is being removed, not carried.
- **Chunks through the JS exporter.** Rejected: 256 KiB of base64 over the bridge every few seconds, and a crash loses the open chunk.
