# React Native SDK: replay over OTLP, `pixel/frames` and `pixel/video` (2026-11-13)

Second pull request of the full-feature React Native SDK ([ADR-0021](../../../../docs/adr/0021-react-native-sdk-keep-and-extend.md) decisions 5 and 6), stacked on step A (PR #183). Not merged: the founder merges.

## What was done

- **Replay goes out as OTLP only.** One protobuf `ExportLogsServiceRequest` per chunk to `<endpoint>/v1/logs`, scope `ouo.replay`, event `ouo.replay.chunk`, the attributes of spec section 11.3, and `ouo.replay.ended` at the end of each stream. The custom `/v1/replay/chunks` upload, `replayEndpoint` and `keepAtNextLaunch` are gone from the JS SDK. A hand-written protobuf writer on each platform produces byte-identical requests: one golden request (721 bytes) is asserted on iOS, Android and in the fake Collector's decoder.
- **One option, `replay.mode`**: `pixel/frames` (default, `ouo-frames/3`) and `pixel/video` (`ouo-video/1`) on iOS and Android 8+. No shorthand; an invalid or unsupported value leaves replay off with one warning. The old cadence values moved to `replay.cadence`. Buffer-on-error is `replay.onErrorSampleRate` with a memory ring of whole segments, flushed by a bypass-set record or `rum.replay.capture()`.
- **`pixel/frames`**: ouo's recorder behind a format-adapter seam, chunked into streams, segments and sequences per spec 11.2, delivered from a disk queue with the spec's retry table (full jitter, `Retry-After` on 429 and 503 only, at least 100 ms and at most 300 s).
- **`pixel/video`**:
  - iOS takes sentry-cocoa 9.33.0's recorder core from the spike of PR #181, merged here whole. It now asks the frames recorder's mask plan before each render, so both recorders mask the same by construction.
  - Android copies only sentry-java 8.64.0's video encoder (4 files, 511 lines, MIT) and keeps ouo's capture and masks. Sentry's Android masking cannot honour ouo's overrides without editing upstream, and it needs Jetpack Compose to build.
  - Both have a sync script (`check`, `diff`, `vendor`) and a `NOTICE`.
- **Masking leaks fixed**:
  - **iOS video transition leak.** Sentry's redaction walked presentation layers that did not yet hold what `drawHierarchy` drew. Fixed by using the frames recorder's mask plan.
  - **Scroll leak, in both iOS recorders.** An animated scroll slid text from under its masks. A scroll view that moved in the last 0.1 s now drops frames whose masked content it holds.
- **View-level masking** (`rum.replay.mask(ref)` / `unmask(ref)`, `testID` `ouo-mask` / `ouo-unmask`) goes through one registry per platform that both recorders read; secure fields are always masked.
- **Fake Collector** (`examples/ouo-mobile/scripts/fake-collector.mjs`): decodes replay requests and checks section 11 (attributes and types, sequence, keyframes, sha256 and size, body decoding for both formats, one end record per stream, replay `session.id` equal to telemetry's, faulted requests retried with the same bytes), with fault injection (`--status`, `--retry-after`, `--fail-first`).
- `session.backgroundTimeoutMs` now defaults to the spec's 15 minutes; the old 30 s sat below step A's one-minute clamp.

## How it was verified

Each run used a Release build of `examples/ouo-mobile` on a simulator or emulator created for the run and deleted after, against the fake Collector. Evidence is in [reports/](../reports/index.md).

| Check | iOS Simulator (iOS 27) | Android emulator (Android 15) |
|---|---|---|
| `pixel/frames`: every section 11 rule | pass | pass |
| 503 with `Retry-After`, then 200: same bytes later | pass | pass |
| 400: chunk dropped, no renumbering, app up | pass | pass |
| `ouo.replay.ended`: kill then relaunch (`partial`), shutdown or rotation (`complete`) | pass | pass |
| Default masking on decoded frames, by eye | pass (all text, inputs, images) | pass (`SECRET4242` unreadable) |
| `pixel/video`: section 11 rules, mp4 opens | pass (AVFoundation) | pass |
| Masked text readable, OCR plus eye | 0 of 10 video runs, 0 of 10 frames runs (the spike leaked in 5 of 6) | 0 in 2 video runs and 1 frames run, 60 transitions each |
| No crash or ANR | pass | pass |

Unit tests after the review fixes: React Native 322 (vitest) and `tsc` clean, fake Collector 8, iOS 329 (`sdk/ios/test.sh`: 34 + 77 + 194 + 24; four tests of the removed `VideoChunk` went), Android JVM 70; both Sentry sync checks pass; the iOS package and `examples/ouo-ios` compile for the simulator with `xcodebuild`, Android `:replay:compileDebugKotlin` passes. Capture cost on iOS: one look per second at 14 to 27 ms of main thread in the demo; a still screen sends nothing.

## Review fixes (PR #184 review, 2026-11-13)

Each must-fix has the reviewer's test in the suite.

- **Consent withdrawal sends nothing further (PRV-4).** JS calls only `discardPending()` (a build without it still gets `stop()`); it stops without an end record. The delete is one step on the disk queue's thread (`DiskQueue.removeAll`), so no send starts between two deletes; a request already on the wire can still arrive. On iOS, a stream whose end waits for the video core's last segment is abandoned by the withdrawal.
- **The main thread never waits for the stream's lock (ERR-4).** `ReplayStream` publishes `isActive`, `isPartial`, `stats` and `producedChunks` outside the lock it holds across encoding and disk writes (a copy under a small lock on iOS, volatile fields on Android). iOS `markGap` and `chunkLost` moved off the main thread. Test: a sink write held 300 ms, reads return in under 50 ms.
- **The mask registry fails closed.** A `mask()` beyond 10 000 tags saturates the registry: until `reset()` every view with a React tag is masked and no unmask by tag is honoured. Memory stays bounded by the same limit.
- **iOS restart in one process**: a new recorder starts only after the previous one's end is queued, so it no longer reads the old stream's open-stream file and sends a false `partial` end.
- **`Retry-After: 0`** waits 100 ms; Android honours `Retry-After` on 429 and 503 only, as iOS.
- **Fabric `mask(ref)` on iOS** reads the tag of any view whose class chain has an `RCT` class (every Fabric component view descends from `RCTViewComponentView`).
- **Replay drops reach `ouo.sdk.dropped` (ERR-7)** with signal `replay`, read from `replayDiagnostics()` once per report interval and on flush. A per-stream counter restarts on a rotation; the JS side counts a lower value whole, so drops between the last read and a rotation can be missed.
- **No `DispatchQueue.main.sync` from the JavaScript thread**: the recorder reference, `isRecording` and diagnostics are read from published state.
- Smaller: the iOS scroll observer is removed on stop; video touches are filtered to `[start, end)`; `docs/specs/mobile-replay.md` describes Android in `ouo-video/1`.
- **Removed the legacy `kind: "video"` recorder from `sdk/ios`** (`VideoReplayRecorder`, `VideoChunk`, `ChunkUploader.enqueue(VideoChunk)`, `OuoReplayConfig.recorder`, `OuoConfig.replayRecorder`, `OUO_RECORDER` in `examples/ouo-ios`). The collector receiver keeps accepting the chunk.
- **Not changed: one fault budget per process.** The counters (iOS: recorder faults and stream errors; Android: recorder, pipeline and stream) still each stop capture at 20. Unifying them means threading a shared budget through `ReplayStream`'s public constructor on both platforms; with the published `isActive` the polling it would remove is already lock-free, so it was left for a later change. A rotation starts a new stream with its own count, so a process can exceed 20 errors in total (ERR-6 asks for one threshold per process).
- **For the store side (RPL-22)**: a loss reported after a stream ended (`chunkLost` on a chunk evicted or answered 400 after `ouo.replay.ended` was queued) does not change its end record. A stream ended `complete` can still miss chunks; a reader must check the sequence, not trust `complete`.

## Measurements (iOS, scroll-heavy native journey, medians of 10 runs)

| | `pixel/video` | `pixel/frames` |
|---|---|---|
| KiB per minute | 98 | 209 |
| Main thread per capture, p50 | 45 ms | 28 ms |

On the mostly still React Native demo, video sends more than frames (144 against 112 KiB per minute). Android emulator numbers are an upper bound (its encoder ignored the bitrate).

## What the founder must know

1. **This PR contains PR #181**, including its change to the collector's `ouoreplay` receiver (accepts `kind: "video"` on the legacy path) and its native iOS demo and measurement harness, but not its iOS recorder for that path: after review the SDK records video only over OTLP. If this merges, close PR #181.
2. **Android `pixel/video` departs from "port Sentry's recorder"**: only the encoder is Sentry's. Masking is ouo's on both platforms, which is what makes the two modes mask identically.
3. **Touch coordinates in replay are points, not pixels**, on both platforms (spec SIG-37 asks for pixels). Frames and patches are pixels.
4. **No reader plays these chunks yet.** The Collector has no route for `ouo.replay.chunk` from an SDK and rum-api and the plugin read the old path; that is the Muninn work (PR #180).

## Not done or not verified

- `structure/wireframe`: the recorder choice is in [wireframe-recorder-choice.md](../../../kb/session-replay/borrowing/wireframe-recorder-choice.md) (Datadog's recorders, their format on the wire, rrweb conversion in the reader). It found that Datadog's native recorders do not read React Native text, so the borrowing spans `dd-sdk-reactnative` too, and that Datadog masks text as `x` runs, not `***`. It is the next pull request.
- The buffer ring is in memory, so a crash cannot upload it on the next launch. The 72 hour queue expiry is not implemented.
- `replayId`, `keyframeIntervalMs` and `chunkMaxBytes` are not passed from JS; native defaults apply.
- Android masking gaps: Jetpack Compose content is masked whole only while text masking is on, and Compose secure fields are not detected. Popups and partial dialogs are not recorded.
- The new iOS UIKit test suite runs only with `test.sh --uikit <udid>` on a simulator; CI does not run it.
- No physical device was used.

## Dependencies added

None from a package manager. Vendored source: sentry-cocoa 9.33.0 recorder core (MIT, 28 files, `sdk/ios`), sentry-java 8.64.0 video encoder (MIT, 4 files, `sdk/android/replay-sentry-core`), each needed for `pixel/video` and credited in `NOTICE`.

## Edits outside `sdk/react-native` and `examples/ouo-mobile`

`sdk/ios` and `sdk/android` (new OTLP, format, mask-registry and Sentry-core code; the native SDKs' legacy frames upload is unchanged, the iOS `kind: "video"` spike recorder is removed), `examples/ouo-ios` (from PR #181; `OUO_RECORDER` removed) and `collector/receiver/ouoreplayreceiver` (from PR #181), `docs/specs/mobile-replay.md` (`ouo-video/1` section), `project/kb/session-replay/`, `project/agents/session-replay/` (PR #181), this folder.
