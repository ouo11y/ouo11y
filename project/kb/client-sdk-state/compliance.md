# SDK compliance with the draft spec

How far do the four SDKs on `main` meet the [draft SDK spec](../opentelemetry/rum-semantic-conventions/sdk-spec.md) (`0.1.0-draft`)? Step 5 of the post-MVP plan, 2026-11-10, at commit `3e9e2c11`. Every requirement, platform, evidence pointer and note is in the [report](sdk-state-report.html#table); the raw audit files are in [`project/agents/sdk-state/findings/`](../../agents/sdk-state/findings/index.md).

## Headline

Of the MUST rows that apply to each platform:

| SDK | Version | Met | Partly met | Not met | Not applicable |
|---|---|---|---|---|---|
| Web (`sdk/browser`) | 0.3.1 | **42 of 157 (27 %)** | 38 | 77 | 35 |
| iOS (`sdk/ios`) | 0.3.0 | **40 of 152 (26 %)** | 46 | 66 | 40 |
| Android (`sdk/android`) | none, vendored in RN 0.3.0 | **30 of 152 (20 %)** | 42 | 80 | 40 |
| React Native (`sdk/react-native`) | 0.3.0 | **40 of 160 (25 %)** | 50 | 70 | 32 |
| All four | | **152 of 621 (24 %)** | 176 | 293 | 147 |

No SDK is conformant at `0.1.0-draft`, and none could be: the SDKs predate the spec by weeks and were built to the MVP's own conventions. The low score is mostly a small number of structural differences repeated across many requirements, listed below. Twenty-three MUSTs are met everywhere they apply (for example LIF-6 no `unload` handler, SIG-40 export requests not instrumented, TRN-16 keepalive budget on the web, PRV-12 no bodies or headers, ERR-2 patched functions keep their behaviour).

The Android row judges what a native Android app would get from `sdk/android` alone. That code has no public init, session, sampling, consent or OTLP exporter: the React Native JS layer supplies all of them. So most Android "not met" rows are "not built yet on Android", not wrong behaviour.

The five SHOULDs and one MAY: TRN-2 (gzip) and RPL-9 (keyframe interval) are met almost everywhere; SES-6 (throttled last-activity writes) and SES-7 (`session.end` attributes) are partly met at best; API-4 (same names across platforms) is partly met.

## By spec area

MUST rows, met / partly / not met, out of those that apply.

| Area | Web | iOS | Android | RN |
|---|---|---|---|---|
| REL relation to OTel | 2/1/3 of 6 | 3/0/3 of 6 | 2/1/3 of 6 | 1/1/4 of 6 |
| API public API | 1/1/3 of 5 | 0/4/1 of 5 | 0/2/3 of 5 | 1/2/2 of 5 |
| CFG configuration | 1/1/2 of 4 | 1/2/1 of 4 | 1/0/3 of 4 | 0/2/2 of 4 |
| LIF lifecycle | 6/2/2 of 10 | 2/2/4 of 8 | 2/6/1 of 9 | 3/5/1 of 9 |
| SES sessions | 2/4/3 of 9 | 2/5/4 of 11 | 0/2/9 of 11 | 1/6/4 of 11 |
| SIG signals | 5/5/16 of 26 | 8/6/13 of 27 | 5/5/16 of 26 | 7/8/18 of 33 |
| REC record rules | 1/3/5 of 9 | 2/3/4 of 9 | 1/3/5 of 9 | 3/3/3 of 9 |
| RES resource | 3/1/1 of 5 | 2/2/1 of 5 | 4/0/1 of 5 | 4/1/0 of 5 |
| PRP propagation | 3/1/2 of 6 | 2/0/2 of 4 | 1/0/3 of 4 | 1/2/1 of 4 |
| TRN transport | 4/8/7 of 19 | 5/8/2 of 15 | 2/11/2 of 15 | 7/7/1 of 15 |
| SMP sampling | 4/3/5 of 12 | 1/3/8 of 12 | 0/0/12 of 12 | 1/3/8 of 12 |
| PRV privacy | 2/2/8 of 12 | 3/2/7 of 12 | 5/1/5 of 11 | 3/1/8 of 12 |
| RPL replay | 3/4/16 of 23 | 4/8/11 of 23 | 4/7/12 of 23 | 3/7/13 of 23 |
| ERR error handling | 5/2/2 of 9 | 5/1/3 of 9 | 3/4/2 of 9 | 5/2/2 of 9 |
| VER versioning | 0/0/2 of 2 | 0/0/2 of 2 | 0/0/3 of 3 | 0/0/3 of 3 |

OVH-1 is not applicable until section 13 has numbers ([overhead.md](overhead.md) proposes them).

## The structural differences

Each of these accounts for many rows. Fixing them is most of the work to conformance.

1. **Replay is not OTLP** (REL-2, TRN-1, RPL-1 to RPL-27, all four SDKs). Chunks are custom gzip JSON (`rrweb` events on the web, `frames` schema 2 on mobile) posted to `/v1/replay/chunks` on a separate receiver (port 4319), with `x-ouo-session-id` and `x-ouo-seq` headers. There is no replay id, stream id, segment index, keyframe flag, sha256, `ouo.replay.ended` record, buffer-mode ring with keyframe retention, or format-adapter seam. Web chunks are not persisted before their first send (RPL-15).
2. **Names predate the spec** (REL-3, REC-1, REC-5, VER-3, SIG-*). Every SDK sets the deprecated `event.name` attribute; emits unprefixed custom names (`navigation`, `web_vital`, `ui.tap`, `app.lifecycle`, `log`, `http.request`, `http.request.failed`); uses its package name as the instrumentation scope instead of `ouo.rum` and sets no `schema_url`. Mobile crashes and hangs are `exception` events instead of `app.crash` and `ouo.app.hang`; app start is an event, not an `AppStart` span. No SDK sets `ouo.view.id` (REC-2, SIG-25).
3. **No privacy layer** (PRV-1 to PRV-4, PRV-10, PRV-13, CFG-4). No `setConsent`, no `beforeSend`, no URL sanitising: `url.full` carries query values, credentials and fragments. A random install-wide `user.id` is on every record before `setUser`, `device.id` is on the resource (RES-2), and `session.id` / `user.id` baggage is sent by default (PRP-6). Mobile secure text fields can be unmasked (PRV-7).
4. **Sessions and sampling follow MVP rules** (SES-1, SES-4, SES-5, SES-13/14, SMP-2, SMP-3, SMP-5 to SMP-7). Ids are dashed UUIDv4. Network requests count as activity. `session.previous_id` is on every record. Mobile rotates the session on every cold start. Sampling is a salted FNV hash, not the spec's hex-prefix rule, and unsampled sessions drop everything: there is no bypass set, so crashes in unsampled sessions are lost.
5. **Robustness and diagnostics** (CFG-1, ERR-4, ERR-6, ERR-7, LIF-4/5). Web and RN `initRUM` throw on missing config; there is no `ouo.sdk.dropped` event and no self-disable threshold in any SDK; iOS has no `shutdown` and reads and writes `session.json` on the main thread; Android SDK threads have unguarded work that can crash the host app on bad config.
6. **OTel embedding** (REL-4, REL-5, spec section 1 table). Web and RN use the OTel JS SDK but register their providers globally by default. iOS and Android are custom (ADR-0016 rejected `opentelemetry-swift` in-process) and expose no tracer or logger provider, so the spec's "wrap `opentelemetry-swift` / `opentelemetry-android`" is not met. RN owns session, queue and exporter in JS, the reverse of SIG-42.

## Things the SDKs do that the spec does not allow

78 findings across the four SDKs, listed per SDK in the [report](sdk-state-report.html#violations). Beyond the six themes above, these deserve attention before Step 12:

- **RN debug log prints part of the project token** (ERR-8, CFG-3).
- **Android: a bad `jpegQuality` throws on an SDK thread and crashes the app** (ERR-1, CFG-1).
- **iOS forces the `traceparent` sampled flag to `01` in unsampled sessions** (SMP-4).
- **Web and RN overwrite an app-set `traceparent`** (PRP-3).
- **Web emits `click` and `soft-navigation` spans that parent requests across page views** (REC-6, SIG-38, SIG-41), and `documentLoad` has child spans (SIG-15).
- **Web and RN report `console.error` as `exception`** (SIG-08; Step 4 targets console-as-error as Never).
- **Web retries 500 and 408** (TRN-6 says drop); Android retries without jitter and does not cap `Retry-After` (TRN-7, TRN-8).
- **Android replay coordinates are in dp, not pixels** (SIG-37), and replay chunks are gzipped twice (TRN-1).
- **RN replaces the Hermes rejection tracker without chaining** (ERR-3).

## How it was checked

- One auditor per SDK read the source under `sdk/` and graded all 199 requirement ids, with `file:line` evidence per row. The brief and the raw output are in the agent folder.
- Unit tests were run on this commit: browser 27 files and 202 tests, React Native 23 files and 212 tests, iOS 233 tests in 31 suites (`sdk/ios/test.sh`), Android JVM 26 tests (`:replay-core:test :signals-core:test`). All passed. Tests show the SDKs work as designed; they do not test the spec.
- About 12 random rows per SDK were re-checked by opening the cited line. All pointed at the code they describe.
- **Not done:** no wire capture against a fake Collector for the audit (the [overhead](overhead.md) harness captured web traffic, which matches the audit's description of paths and encodings), no browser e2e run, no simulator or emulator run for compliance. Rows marked `read` rest on reading code. Section 14's conformance suite does not exist yet; this audit is not a substitute for it.
