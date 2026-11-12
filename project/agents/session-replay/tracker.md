# session-replay tracker

| Item | Status | Where |
|---|---|---|
| Sentry iOS recorder core behind a switch (spike) | review (founder decides) | branch `claude/sentry-recorder-ios`, [summary](summaries/2026-11-11-sentry-recorder-ios-spike.md) |
| Transition-frame leak in the Sentry core: trace the cause, test on a device | todo | [kb finding 1](../../kb/session-replay/borrowing/sentry-ios-recorder-spike.md#findings) |
| Video recorder: crash spool, navigation mode, feedback frame, ouo-mask/unmask mapping | todo, only if ADR-0018 is accepted | same |
| PostHog and Datadog formats behind the same `OuoSegmentRecorder` | todo, only if ADR-0018 is accepted | |
