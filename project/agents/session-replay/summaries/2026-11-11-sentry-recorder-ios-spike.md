# 2026-11-11: Sentry iOS recorder core behind a switch (spike)

Branch `claude/sentry-recorder-ios`, cut from `origin/main` 27f7101e. The parent is the session-replay internals session (PR #178, the proposed ADR-0018). Not merged: the founder decides.

## Done

- **Copy.** sentry-cocoa 9.33.0's recorder core (MIT) is in `sdk/ios/Sources/OuoReplaySentryCore/Upstream/`: 28 files, 3,157 lines, unmodified apart from three scripted transforms. The one ObjC helper is in `OuoReplaySentryCoreObjC`. `THIRD_PARTY_NOTICES` carries the licence, and every copied file has a header with the tag, path and notice.
- **Seams.** `Seams.swift` stands in for the log, queue wrapper, date provider and run-loop typealiases. `SentryCoreRecorder` replaces `SentrySessionReplay`: it keeps the pacing and the 5 s segment cut and drops the hub, envelope and events. `OuoSegmentRecorder` is the ouo protocol: it hands out finished segments (mp4, start, end, width, height, frame count, frame rate).
- **Sync.** `sdk/ios/scripts/sentry-core-sync.sh check | diff <tag> | vendor <tag>`.
- **Switch.**
  - `OuoReplayConfig.recorder` / `OuoConfig.replayRecorder`: `.frames` (default, unchanged) or `.sentryVideo`.
  - `VideoReplayRecorder` wraps each segment as a `VideoChunk` (`kind: "video"`, `format: "sentry-video"`) and adds touches, session id and seq. It sends through the existing `ChunkUploader`, which gained `enqueue(VideoChunk)` and `enqueue(json:...)`.
  - `OuoReplay.captureStats` reports main-thread ms per capture for both recorders.
- **Collector.** `ouoreplayreceiver` accepts `kind: "video"` (rum-api's rules, the frames body limit) and writes `ouo.replay.format` from `format`.
  - Route chosen: (a), as the parent's correction offered. It is the smallest honest route: the OTLP `ouo.replay.chunk` path does not exist in the iOS SDK or rum-api, and the bridge only takes Sentry envelopes.
- **Docs.** `docs/specs/mobile-replay.md` (the video chunk section), `sdk/ios/README.md`, `collector/README.md`.
- **Example and harness.**
  - `examples/ouo-ios`: `OUO_RECORDER`, a Statement screen and `OUO_ACTION=replaydemo`.
  - `project/agents/session-replay/measure/`: sink, runner, frame rebuild with Vision OCR, analysis, `results.json`.
- **kb and report.** `project/kb/session-replay/borrowing/sentry-ios-recorder-spike.md` and `reports/sentry-recorder-spike.html` (with images).

## Verified, and how

- `sdk/ios/test.sh`: all suites pass, including the new `VideoChunkTests` (keys, round trip, uploader headers, `CaptureStats`).
- `xcodebuild -scheme OuoSDK` builds for the iOS Simulator. `sentry-core-sync.sh check` passes. `diff 9.32.0` is empty and `diff 9.30.2` shows 12 lines.
- `collector/receiver/ouoreplayreceiver`: `go test ./...` and `go vet` are clean. Six new video cases plus the format attribute.
- **End to end.** `deploy/envs/ouo-env up sentryrec` (built with `--src` from a detached worktree, see below). The replaydemo ran in the simulator with each recorder. rum-api stored `kind: "video"`, 14 chunks, 76 frames, and `kind: "frames"`, 8 chunks, 37 frames. Both played in the Grafana plugin; screenshots are in the report. The env was torn down afterwards.
- **Measurements.** 5 interleaved rounds per recorder: Sentry 170 against 283 KiB/min, 47.6 against 29.4 ms main thread per capture (p50), 55 against 37 frames, readable-text frames 2/272 against 0/185.

## Not done, open

- No crash spool, `navigation` mode or feedback frame for the video recorder, and no mapping of ouo's mask/unmask overrides to Sentry's.
- No device run.
- No off-main-thread CPU or memory measurement.
- The transition leak's root cause is not traced (observed in frames only).
- The OTLP section 11 path is not built.

## For the next agent

- **The shared main checkout is mid-merge.** It has conflict markers in five `package.json` files, so npm fails from every worktree under `.claude/worktrees/` and `ouo-env up` fails at the plugin build. Use `git worktree add --detach <dir outside the checkout> HEAD` and `ouo-env up <env> --src <dir>`.
- **Indexes.** The `session-replay` index files on this branch are minimal on purpose. PR #178 owns them; merge their rows when the second PR lands.
- **ADR-0018.** Its findings went to the parent session; this branch does not edit the ADR.
- **New dependency.** sentry-cocoa source, copied rather than linked, because ouo needs only the recorder core, without the Sentry SDK or its hub.
