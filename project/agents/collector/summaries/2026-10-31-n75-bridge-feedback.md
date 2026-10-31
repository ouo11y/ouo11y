# 2026-10-31: Sentry bridge feedback end to end (N75)

Branch `claude/n75-bridge-feedback`, env `n75-bridge-feedback`, own simulator `ouo-n75-bridge-feedback` (2E9BB903-794C-4DDA-A45E-CB3C9D4FDD4E, iPhone 18 Pro, iOS 27). Checklist N75 (W6 review item 9). Paths: `collector/receiver/ouosentryreceiver`, `docs/specs/sentry-bridge.md` 9c, `examples/sentry-mobile` (app action, journeys, verify), this folder, `project/kb/feedback.md`, the checklist.

## Done

- **Held user reports** (`logs.go`, `translate.go`, `feedback.go`): a `user_report` whose error is not known yet goes into the held-logs queue (`pendingLog.report`), keyed by the error's event id. Same hold (`log_hold`, 1 min), same flush (after every envelope, every 5 s, at shutdown), same 20 000-entry bound (beyond it: emitted at once without a session, `ouo_sentry_translate_dropped_total{reason="user_report_unresolved_overflow"}`). When the error arrives in a known session, the report takes it with rule `event`; else it goes out with `none` after the hold. An empty report is not held. One queue for both instead of a second one: the hold, expiry, bound and shutdown are the same.
- **Spec** 9c says so; the metrics list names both overflow reasons (`log_unresolved_overflow` was missing).
- **CI journey** (`scripts/ci-journey.py`): an error, a `user_report` naming it, a `user_report` sent 0.5 s before its error (the held path), a `captureFeedback` event (`feedback` item with the user's id, a trace and a navigation breadcrumb to Cart, no session item: rule `device`). It writes the expected records into `journey.json`.
- **verify.py**: with `feedback` in `journey.json`, the expected records on the session timelines in rum-api, each once: message, contact, id (exact UUID, none for a report, or any), the allowed session rules, and for the `captureFeedback` its breadcrumb's navigation before it on the same session.
- **App** (`feedback` action, Home button, `journey.sh` errors phase): `captureException`, `Sentry.captureFeedback`, and the legacy `user_report` built by hand (`@sentry/react-native` 8 has no `captureUserFeedback`), through `src/monitoring.ts` so the rollout modes apply. `run.sh` writes its expectations (any session rule for the feedback, `event` for the report).

No dependency added.

## Verified

- `go vet ./...`, `go test -race -count=1 ./...` in `collector/receiver/ouosentryreceiver`: pass. New tests `TestUserReportHeldUntilItsError` (held, resolved by its error with rule `event`, the other expires to `none`, empty not held) and `TestUserReportHoldOverflow`; `TestUserReport` now flushes the held one.
- CI journey against env `n75-bridge-feedback` (collector built from this branch): `ci-journey.py` + `verify.py` **22/22**, among them `'Sent before its error' event` (the held report on the session). On a bridge without the hold that report has no session and the check fails.
- Simulator: Release build of `examples/sentry-mobile` (`@sentry/react-native` 8.32.0) on my own simulator against the env, `scripts/run.sh --env n75-bridge-feedback`: **19/19**. The real `captureFeedback` landed on the errored session by rule `replay` (the mobile replay integration puts `contexts.replay` on it) with its UUID id and contact; the hand-built `user_report` through the RN native transport landed on the same session by rule `event`, no id.
- `tsc --noEmit` in `examples/sentry-mobile`; `lychee --offline` clean.

## Left / next

- A `feedback` item whose only link is `associated_event_id` to an unknown error is still emitted at once (`none`); the checklist asked for user reports only.
- N76 (feedback frame on iOS) is unchanged.
