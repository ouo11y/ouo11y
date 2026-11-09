# 2026-10-23 · sentry-cocoa session replay internals (kb-sentry-ios-replay-internals)

Branch `claude/kb-sentry-ios-replay-internals-c06ec4` from `origin/main` 8121faf. Docs only, no SDK
code changed, the iPhone not touched. kb: [sentry-ios-replay-internals.md](../../../kb-archive/sentry-ios-replay-internals.md).

## Done

- Read sentry-cocoa at tag `9.31.0` (the version `@sentry/react-native` 8.32.0 pins in
  `RNSentry.podspec`, and the latest stable tag today) and at tag `8.32.0`, shallow clones in the
  session scratchpad, nothing vendored. Read ouo's capture path (`ReplayRecorder`, `ScreenCapturer`,
  `ViewTreeBuilder`, `FrameComposer`) first.
- Wrote the kb entry: renderer selection and defaults, redaction walk (main) and mask (queue),
  run-loop observer scheduling with animation deferral and backoff, PNG + H.264 encoding and
  segments, scale handling, session vs buffer mode, a side-by-side table marking main-thread steps,
  and a ranked change list for `sdk/ios`, all with file and line references at the tag.

## Findings the next agent must know

- "Sentry 8.32.0" in the benchmark is the RN SDK; the native code is sentry-cocoa **9.31.0**.
  sentry-cocoa 8.32.0 is a 2024 version with a display-link loop and `UIGraphicsImageRenderer`.
- Sentry draws `drawHierarchy(afterScreenUpdates: false)` **1:1 at the native 3x scale** on main
  and downsamples to 1x on a queue with nearest-neighbour sampling. ouo draws at 1.0 on main, so
  the 3x -> 1x resample runs inside drawHierarchy on the main thread. That is the main hypothesis
  for 45 vs 22 ms; it is not measured yet.
- Sentry never captures on touches and keeps one capture in flight; ouo adds up to 4 touch
  captures per second and allows 2 in flight (95 vs 73-83 captures per run).
- The benchmark runs Sentry with text and image masking off; ouo masks images, inputs and web views.
- No Sentry quality setting (`sizeScale`, bit rate) changes its main-thread cost.

## Verified and how

Source reading only: every claim cites a file and line range at the tag; line ranges re-checked
with `sed -n` after writing. The benchmark's Sentry options were read from
`examples/sentry-mobile/src/sentry.ts` and the `@sentry/react-native@8.32.0` npm package
(`RNSentry.podspec` line 71, `dist/js/replay/mobilereplay.js` lines 27-29, `ios/RNSentryReplay.mm`).
`lychee --offline` on the changed files.

## Left

- Device A/B of change 1 (1:1 render + queue downscale vs `interpolationQuality = .none` at 1x),
  with the `snapshot` signpost split into `walk` and `draw` first (change 0). Needs the iPhone
  (owned by the benchmark session) and an SDK change in a new session.
- Changes 2-6 of the ranked list.

No env started.
