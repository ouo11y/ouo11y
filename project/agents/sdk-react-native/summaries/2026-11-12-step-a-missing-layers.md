# React Native SDK, step A: the missing layers (2026-11-12)

First pull request of the full-feature React Native SDK ([ADR-0021](../../../../docs/adr/0021-react-native-sdk-keep-and-extend.md)). Not merged: the founder merges.

## What was done

- **Audit and decision.** The Step 5 list for React Native is 160 applicable spec MUSTs (40 met, 50 partly, 70 not met at `3e9e2c11`) plus 60 Must features ([audit](../../sdk-state/findings/audit-rn.json)). ADR-0021: keep the OTel JS core and extend it; spec wire only; replay over OTLP chosen by one `replay.mode` string, recorders borrowed from Sentry and Datadog.
- **Step A in `sdk/react-native`** (kb: [step-a-layers.md](../../../kb/client-sdk-react-native/step-a-layers.md)): one guard around every entry point with self-disable; a fault-injection suite with an explicit seam table; configuration that never throws; the spec's API surface with the old names kept; public `shutdown`; `beforeSend`; drop counting and `ouo.sdk.dropped`; no OTel globals unless `otel.registerGlobal`; no span events; truncation; consent; URL sanitising; sampling decided once with the bypass set; session rules; propagation and transport fixes; no anonymous `user.id`.
- `examples/ouo-mobile` sets `propagation.sessionBaggage: true` (the demo backend joins traces to sessions through it).

## How it was verified

- `sdk/react-native`: `npx vitest run` 294 tests in 29 files pass (212 before), `npx tsc --noEmit` clean, sync scripts and `tsup` build. `examples/ouo-mobile`: `npx tsc --noEmit` clean. Run after rebasing on `origin/main` at `533131de`.
- **Not verified:** nothing ran on a simulator, an emulator or a stack. The forwarding of unhandled rejections to Sentry is tested against a fake carrier only.

## Spec rows this closes, and what stays open

Closed or moved to met by unit test: ERR-1, ERR-5, ERR-6, ERR-7, ERR-8, CFG-1 to CFG-4, API-1, API-3, API-6, LIF-4, LIF-5, LIF-13, REL-4, REL-5, REL-7, REC-8, PRV-1 to PRV-3, PRV-10, PRV-11, PRV-13, SMP-1, SMP-3 to SMP-7, PRP-3, PRP-4, PRP-6, SES-5, SES-6, SES-9, SES-10, TRN-4, TRN-7, TRN-8, VER-2.

Partly: ERR-3 (Hermes has no getter for the previous rejection tracker), PRV-4 (unsent replay chunks need a native delete), TRN-6 (`partial_success` read on the JS path only), TRN-11 and TRN-14 (bypass-sparing eviction in the outbox, not in the OTel memory queue), API-4 (`trackNavigation` keeps `(path, attrs)`).

Open, step B: every rename and scope row, `ouo.view.id`, session id format, sampling hash, protobuf, all replay rows, SIG-42 (ADR decision 2 proposes to change it).

## CI jobs expected to fail, and why

The `examples` job runs `tests/e2e/mobile/conformance.mjs`, `examples/ouo-mobile/scripts/verify.py` and the playground against rum-api with MVP expectations. Step A changes behaviour they may rely on: background timeouts below one minute are clamped (the conformance build used 5 s, the playground 2 s), baggage is off unless asked, there is no anonymous `user.id`, query values are redacted. Those files were not edited, by the founder's rule; the pull request lists what failed.

## Dependencies added

None.

## Edits outside `sdk/react-native` and `examples/ouo-mobile`

`docs/adr/` (ADR-0021 and its index row), `project/kb/client-sdk-react-native/`, this folder. None to `sdk/ios` or `sdk/android` in this pull request.

## What the next agent must know

1. Two local branches hold unfinished native replay work, cut off by a usage limit and saved as WIP commits: `worktree-agent-a43dc2dea6bdd0e5f` (iOS: OTLP protobuf writer, chunk and stream code, a hand-written wireframe recorder) and `worktree-agent-a038e57649ee97c69` (Android: the same). The wireframe recorders are parked (ADR-0021 decision 6); the envelope, chunking and stream code is to be reused for `pixel/frames` and `pixel/video`.
2. `pixel/video` on iOS builds on PR #181 (`claude/sentry-recorder-ios`).
3. `npm` at a worktree root needs `--prefix "$PWD"` while the main checkout is mid-merge ([kb](../../../kb/client-sdk-react-native/npm-in-worktrees.md)).
4. No env was started, no simulator or emulator booted by this run.
