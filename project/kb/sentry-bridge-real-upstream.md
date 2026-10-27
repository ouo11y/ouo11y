# The Sentry bridge with a real upstream: "keep Sentry, add ouo" (M4, 2026-10-28)

Question: what does a team see when its `@sentry/react-native` app keeps its Sentry and only the
DSN host moves to the ouo bridge, and what happens when Sentry rate limits or is down? Found while
building `examples/quickstarts-mobile/tiny-shop-mobile-sentry` (N61): Expo 57.0.31, RN 0.86.3,
`@sentry/react-native` 8.32.0 (sentry-cocoa 9.31.0), collector 0.4.0, iOS 27 simulator.

## DSN mapping

- App DSN: `http://<public key>@<bridge host>:4320/<project id>`, key and project from the Sentry
  DSN. Bridge project table: the same pair, `upstream` = the DSN's scheme and host
  (`https://o<org>.ingest.<region>.sentry.io` on sentry.io).
- A Sentry on the same machine is `http://host.docker.internal:9000` from the collector container,
  never `localhost`; the quickstart's collector compose adds `extra_hosts: host-gateway` so this also
  works on Linux Docker.
- Unknown key or project: `403`, nothing forwarded, `ouo_sentry_envelopes_total{outcome="rejected"}`.

## Upstream behaviour, measured with `collector/tools/sentrytap`

- Normal: Debug run 21/21 and Release run (JS fatal, native crash, relaunches) 42/42 envelopes
  byte-identical at the fake upstream. Against self-hosted Sentry 26.10: 40 envelopes, all `200`,
  Sentry's `Server: nginx` header passed through.
- **429** (`sentrytap -sink -status 429 -rate-limits 60::organization -retry-after 60`): status,
  `Retry-After` and `X-Sentry-Rate-Limits` reach the SDK unchanged; the SDK sent nothing more for
  60 s; the envelope was not translated (no `exception` in Loki).
- **Upstream down** (fake Sentry stopped): the client side sees `EOF` (the bridge aborts, as the
  spec says). sentry-cocoa kept the envelope and resent it (same `event_id`, different body bytes)
  at its next send after a relaunch; ouo recorded it once.
- An error Sentry refused still counts in the next session update's `errors`, so the bridge emits
  `sentry.unsampled_error` placeholders (no message) to keep ouo's error count equal to Sentry's.
- **Metric gap:** a `429` (any non-2xx answer) counts as `outcome="forwarded"`, and its items are
  not counted in `ouo_sentry_items_total` at all. Nothing in ouo shows how much Sentry refused.
- `sentry_ui_url` in the project table is parsed (`config.go`) but unused: no link from an ouo
  error to the Sentry event yet. Event, trace and replay ids are equal on both sides; Sentry's
  Explore search takes `trace:<id>`.

## Same session, both UIs (self-hosted Sentry 26.10, one journey)

Equal: 3 sessions (2 crashed, 1 healthy), 3 error events (handled, JS fatal, `EXC_BAD_ACCESS`),
3 app logs and 3 console lines, replay ids and segment counts (13 and 3), the checkout trace id
(Sentry 2 app spans; Tempo the same 2 plus the API's 6). ouo's session page also listed every
request, taps, navigations, cold start and TTID. Sentry only: issue grouping, symbolication with
uploaded maps / dSYMs, tags and attachments (not copied by design).

## Expo 57 + Sentry pitfalls

- `npx expo install @sentry/react-native` picks 7.11.0 for SDK 57 (partial support, see
  `sentry-bridge-examples.md`); install `8.32.0` with npm. `startNewTrace` needs `@sentry/core`
  at the SDK's exact version (10.76.2).
- `create-expo-app --template blank-typescript@sdk-57` (Expo 58 is `latest`) also writes
  `AGENTS.md`, `.claude/settings.json`, `LICENSE` and a `.git` repo into the app folder.
- CocoaPods 1.17 under Ruby 4 fails with `Unicode Normalization not appropriate for ASCII-8BIT`
  without `LANG=en_US.UTF-8`; `expo run:ios` then goes on to `xcodebuild` without pods.
- A Debug build (Metro) sends `replay_video` segments too; only the JS fatal needs Release (the red
  screen keeps a Debug app alive).
- `disableAutoUpload: true` writes `export SENTRY_DISABLE_AUTO_UPLOAD=true` into both Sentry build
  phases ("skipping debug files upload"): the build never calls sentry.io.
- Self-hosted Sentry: the taskbroker stall from `sentry-self-hosted.md` happened again right after
  `up --wait` (Relay `deadline exceeded`); `restart taskbroker` cleared it and Relay delivered.
