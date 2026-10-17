# 2026-10-14 Sentry bridge: build and verification

## Asked

The founder's iOS and Android apps run Sentry SDKs. Point the Sentry SDK at the collector. The collector forwards everything to Sentry as if it were not there, sends session replay to rum-api, and sends traces and logs to LGTM. Work in phases and verify each one strongly.

Later scope decisions from the founder:
- Android is skipped for now.
- LGTM was first marked "later", then put back in scope, because the plugin's session list depends on it.

## Done

The work is on branch `claude/sentry-bridge-design`, which is PR #16, stacked on Phase 8a.

- **Collector (done directly):** `collector/receiver/ouosentryreceiver`.
  - Forwarding: DSN key auth, raw-byte forwarding, verbatim response, connection abort when Sentry is unreachable, and `upstream: none`.
  - Translation: envelope parser, sessions, errors, transactions, derived records, session correlation state, and replay to `kind: "video"` chunks with a hold queue.
  - Also `collector/tools/sentrytap`, the `routing` connector in `builder.yaml`, and the receiver, port and pipelines in `deploy/docker/collector/config.yaml` and compose.
- **rum-api agent:** `kind: "video"`: storage, manifest, and mp4 segments with Range support.
- **grafana-plugin agent:** plugin 0.4.0 video player.
- **sentry-demo agent:** `examples/sentry-mobile`, an Expo iOS app on `@sentry/react-native` 8.30.0, with an unattended journey.
- **Golden fixtures:** two real captures, 54 requests, in `collector/receiver/ouosentryreceiver/testdata/golden/`.
- **Verifier:** `examples/sentry-mobile/scripts/verify-bridge.py`, which checks rum-api, Loki, Tempo and the mp4s against the raw envelopes.
- **Docs:** spec, ADR status, kb, tracker and `reports/sentry-bridge-verification.html`.

## Verified, and how

Everything ran in the isolated compose project `ouo-sb`. The ports are in the report. The stacks `ouo` and `ouo-8a` were not touched.

- **S1 forwarding.**
  - Go tests against a fake upstream.
  - Live with real traffic: `sentrytap compare` matched 39 of 39 requests byte-identical with identical responses.
  - Overhead: p50 2.8 ms, p95 4.4 ms.
  - A 429 with rate-limit headers passed through unchanged.
  - When the upstream was down, the client saw an empty reply.
  - Outage run: the SDK retried, then flushed on recovery, and Loki holds one record per event id.
- **S2 telemetry.**
  - Golden tests on both captures, with an invariant that no record or span lands outside its session's window.
  - `verify-bridge.py` passed 25 of 25 on the journey run and 15 of 15 on the outage run.
- **S3 replay.**
  - 26 of 26 segments are byte-identical to the SDK's mp4.
  - AVFoundation decoded all 26.
  - Every segment is in the session it was recorded in.
- **S4 plugin.**
  - Playback works in Grafana on real sessions.
  - Timeline seek lands in the right segment.
  - Range passes through the plugin proxy.

## Found on real traffic and fixed

- **Stale replay id.** After a background rotation, the replay id on transactions is stale. Rule 2 now applies a time-window check.
- **Platform detection.** It now uses the React Native SDK names and `replay_event.platform`. One intermediate bug read "javascript" as Java; it was caught and fixed.
- **Crash end time.** A crashed session now ends at the crash, not at the relaunch.
- **Abnormal end time.** An `abnormal` session now ends at its last activity.
- **Touch moves.** Moves are rrweb source 6, and are now parsed.
- **Restart baseline.** After a bridge restart, later errors were never counted. They are now.
- **msgpack allocation bomb.** Found by the fuzzer. The crashing input is kept as a regression seed.

## Dependencies added

`github.com/open-telemetry/opentelemetry-collector-contrib/connector/routingconnector v0.160.0` in `collector/builder.yaml`. It routes the bridge's replay chunks to the replay pipeline and is a standard contrib component. Everything else uses the standard library or modules already pinned.

## Left

- **Real Sentry upstream:** no run yet against a real sentry.io project as upstream. It needs the founder's DSN.
- **Android:** deferred.
- **Coverage gaps:**
  - Native-only iOS apps were not captured.
  - Only one SDK version was tested.
  - Sentry `log` items are not translated.
- **Deployment:** the receiver state is in memory, so run it as a single replica.
- **Builder version:** the build machine's `builder` is v0.162. Use v0.160.0, installed into a scratch GOBIN in this run, as `kb/collector-components.md` says.
