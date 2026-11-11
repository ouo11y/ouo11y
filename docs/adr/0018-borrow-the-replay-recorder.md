# ADR-0018 Borrow the mobile replay recorder core instead of writing it

Status: **proposed** (2026-11-11). Not accepted until the founder decides.

## Context

Every replay recorder is six steps: hook, record (pixels or structure), mask, pack, ship, play ([six-steps-and-borrowing.md](../../project/kb/session-replay/borrowing/six-steps-and-borrowing.md)). ouo wrote its own mobile pixel recorder ([ADR-0006](../adr-archive/0006-mobile-replay-native-screenshots.md), [ADR-0014](../adr-archive/0014-replay-tiles-in-frames.md)), following Sentry's design. Sentry, PostHog and Datadog have mature open-source recorders under MIT or Apache-2.0. The founder wants to keep OpenTelemetry APIs and SDKs and `ouo.replay.chunk`, borrow what is better borrowed than written, start as soon as possible and refine later.

## Proposal

1. **Copy the recorder core** (hook, record, mask, pack) from open-source SDKs at a pinned tag, with their licence notices, and a script that diffs the copy against newer upstream tags. Cut the seams to the vendor's hub, options and envelope behind a small ouo interface that hands out finished segments.
2. **ouo keeps ship and play**: each segment becomes an `ouo.replay.chunk` through the OpenTelemetry Logs SDK, and `ouo.replay.format` names the format, so one SDK can carry several recorders and the reader picks a decoder per chunk.
3. **Order**: Sentry video first (iOS, then Android), because the plugin already plays `kind: "video"` from the Sentry bridge ([ADR-0008](../adr-archive/0008-sentry-sdk-bridge.md)); PostHog wireframes next; Datadog wireframes last.
4. **Masking**: keep ouo's drop-if-moving check as a patch on the copied code if the masking experiment shows the borrowed masking leaks.

## Consequences

- The OTLP `ouo.replay.chunk` path (sdk-spec §11, decision D3) is not built, and today's `ouoreplay` receiver accepts only `rrweb` and `frames`; `video` comes in only through the Sentry bridge. "Sentry video first" therefore needs either the OTLP path or `video` accepted by `ouoreplay`.

- Less recorder code to own; upstream fixes arrive through the diff script.
- A static screen costs one full picture per 5 s segment instead of zero bytes; light-journey bytes rise about 30% (Sentry iOS 49.5 vs ouo 38.8 KiB/min, Android about 193 vs 142, [overhead.md](../../project/kb/client-sdk-state/overhead.md)).
- ADR-0006 and ADR-0014 would be superseded for mobile capture if this is accepted; the frames format stays readable for old sessions.
- Every new format needs a player.

## Evidence still to come

- The iOS port spike (branch `sentry-recorder-ios`): seam map, bytes and main-thread cost against the current recorder.
- The masking experiment (branch `masking-experiment`): leak rates with confidence intervals for Sentry's masking, ouo's drop-if-moving and alternatives.
