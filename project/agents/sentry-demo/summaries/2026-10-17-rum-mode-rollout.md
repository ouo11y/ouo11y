# 2026-10-17 runtime rollout switch (`ouo.rum.mode`)

## Done

- `examples/sentry-mobile` picks its monitoring at each cold start from the OpenFeature flag
  `ouo.rum.mode`: `sentry` (Sentry through the bridge DSN), `parallel` (Sentry straight to Sentry
  + ouo with replay off), `ouo` (ouo only, replay on). `src/rollout.ts` (decision, device bucket,
  OFREP or in-memory provider), `index.ts` (launch order, root renders null on the first launch
  until decided), `src/sentry.ts` / `src/ouo.ts` now export init functions, `src/monitoring.ts`
  (app's own captureException / captureMessage / flush to whichever SDKs run). The build flag
  `OUO_SDK=1` is replaced (app.config.ts fails with a pointer to ROLLOUT.md).
- `flags/ouo-rum-mode.flagd.json` (80 / 15 / 5 fractional, `appVersion < 1.0.0` stays on Sentry)
  and `flags/compose.yaml` (flagd v0.17.0, OFREP :8016).
- `scripts/rollout-journey.sh` (pin a mode in the flag file, launch A fetches, launch B runs a
  short journey) and `scripts/verify-rollout.py` (Sentry capture, Loki, Tempo, rum-api per cohort).
- `@ouo/react-native`: new `resource` option (extra resource attributes, the SDK's own win),
  unit test `test/resource.test.ts`, README.
- `ouosentryreceiver`: stamps resource `ouo.rum.mode = sentry` (translate.go, breadcrumbs.go),
  test assertion; spec section 4 row.
- Client guide `examples/sentry-mobile/ROLLOUT.md`, kb `project/kb-archive/openfeature-rum-mode.md`.

## Dependencies added (examples/sentry-mobile)

- `@openfeature/web-sdk` 1.10.0: the OpenFeature client API, so any provider can drive the switch.
- `@openfeature/core` 1.12.0: required peer of the web SDK.
- `@openfeature/ofrep-web-provider` 0.4.3: OFREP over plain fetch, served by flagd and most vendors; the flagd web provider needs streaming fetch React Native lacks.

## Verified, and how

- `sdk/react-native`: `npx vitest run` 82/82, `tsc --noEmit` clean. Collector receiver:
  `go test ./...`, `go vet` clean. Example: `npx tsc --noEmit` clean.
- Isolated compose project `ouo-flags` (built from this branch), flagd container, sentrytap on
  :4621 as sentry.io (bridge upstream and direct DSN), own simulator `ouo-flags` (iOS 27).
  `verify-rollout.py`: `sentry` 12/12 (fresh first launch), `parallel` 12/12, `ouo` 10/10.
  Numbers in ROLLOUT.md "What was verified".
- flagd stopped: a later launch keeps the stored mode; a first launch starts `sentry (default)`
  after 1.5 s (screenshot of the status line).
- 2,000 random ids against 80 / 15 / 5: 79.1 / 15.9 / 5.1 %, stable for re-asked ids.
- LogQL cohort split by `ouo_rum_mode` structured metadata works.

## Left / next agent should know

- rum-api sessions and health stats cannot filter by `ouo.rum.mode`; separate `service_name` for
  the bridge is the workaround (follow-up).
- Bridge records Sentry RN info messages as `exception` (attached stack in `exception.values`).
  Reported to the bridge gap-report session via the shared notes.
- A device moving from Sentry to `ouo` never sends sentry-cocoa's cached last-session end or a
  pending native crash report.
- Android not built (no Android SDK on this Mac).

## Merge with main (#21, #22, #24, #25), same day

- Merged main into the branch (not rebased). Resolved `examples/sentry-mobile`: #24's `RUMProvider`,
  `navigationStateListener` and `onReady` (`markFirstFrame()`, `trackNavigation("/Home")`) kept, `ouo`
  read at render time because index.ts starts ouo after App is imported. #25's perf build: 
  `Documents/perf-mode.json` is now `{"mode": none|sentry|parallel|ouo, "ouoReplay"?}` and overrides
  the flag for that launch (src/rollout.ts, no evaluation, nothing stored); `scripts/perf/run.sh` maps
  its five modes onto it; src/perf.ts records the launch's mix. `OUO_REPLAY` replaced like `OUO_SDK`
  (build fails with a pointer): ouo replay follows the mode. project/kb-archive/sdk-overhead-ios.md and
  project/kb-archive/sentry-bridge-vs-ouo-sdk.md rerun instructions updated.
- Re-verified on the same isolated setup: rollout cohorts 12/12, 12/12, 10/10 (ouo cohorts now record
  4 navigation events, `/Home` included); one perf round of all five modes, 95 s each, 19/19 steps,
  `perf.json` mix as intended, deltas in line with the 30-run result.

## Local stacks

- Compose projects started: `ouo-flags` (deploy/compose/compose.yaml) and `ouo-flags-flagd`
  (examples/sentry-mobile/flags/compose.yaml). Both stopped after the PR was opened:
  `ouo-flags` with `down -v` (volumes removed, so its Loki/Tempo data is gone), `ouo-flags-flagd`
  with `down`. sentrytap on :4621 stopped; simulator `ouo-flags` (E87E9B42-...) shut down, not deleted.
- For the re-verification after the merge both projects were started again (Grafana :3011, login
  admin / testing567) and stopped with `docker compose -p ouo-flags down` and
  `docker compose -p ouo-flags-flagd down` (no `-v`, volumes kept). Perf proxy (:4728-4730, :4791)
  and sentrytap stopped, simulator shut down.
