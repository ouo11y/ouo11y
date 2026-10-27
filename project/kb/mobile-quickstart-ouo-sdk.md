# Building and verifying an Expo app on `@ouo11y/react-native` from npm (M5, 2026-10-28)

What bit while building `examples/quickstarts-mobile/tiny-shop-mobile-ouo` (Expo 57, RN 0.86.3,
`@ouo11y/react-native` 0.2.1 from npm, iOS 27.0 simulator, Xcode 27.0).

## App setup

- **`create-expo-app@latest` makes Expo 58 now.** Pin the template: `--template blank-typescript@sdk-57`.
  The template also writes `AGENTS.md`, `.claude/settings.json` and a git repo.
- **`npx expo install`, not `npm install`,** for `@react-native-async-storage/async-storage`: npm gives
  3.1.1; Expo 57 wants 2.2.0. The SDK's peer range (`>=1.21.0`) accepts both.
- **The npm package needs no Metro config and no build step.** `ios/` in the tarball already holds the
  vendored Swift sources (OuoCrash, OuoReplay, OuoVitals and their Core pods); the README's
  `metro.config.js` and `npm run -w sdk/react-native build` notes are for the monorepo `file:` link only.
- **Replay port derivation:** `replayEndpoint` defaults to `endpoint` with 4318 → 4319, and to
  `endpoint` itself for any other port. With a moved collector (`:35318`) chunks go to the OTLP port
  and are lost silently. Pass `replayEndpoint` whenever the port is not 4318.
- **A local Expo module (`modules/<name>/` with `expo-module.config.json` + `ios/*.podspec`) is not
  linked by `expo run:ios` when `ios/` already exists:** it skips `pod install` when package.json did
  not change, and JS fails with `Cannot find native module`. `npx expo prebuild --platform ios` runs
  the pods again. Autolinking scans `modules/*/ios/*.podspec` (one directory level).
- **No `nativeCrash()` in the ouo SDK.** A 10-line local module (`UnsafeMutablePointer<Int>(bitPattern: 0x8)!.pointee = 42`)
  gives `EXC_BAD_ACCESS` / `SIGSEGV`; the SDK reports it on the next launch, Debug or Release, as long
  as no debugger is attached.
- Replay records in Debug builds too (nothing in the SDK checks `__DEV__`).

## Verification harness (no simulator panel)

- **Real taps by `testID`:** an XCUITest bundle generated like
  `examples/sentry-mobile/scripts/perf/make-driver.rb`, with one test that reads `STEPS`
  (`TEST_RUNNER_STEPS=…`): `tap:<id>` (`app.descendants(matching: .any).matching(identifier:)`),
  `type:<id>=<text>`, `back` (`navigationBars.buttons.element(boundBy: 0)`), `home`
  (`XCUIDevice.shared.press(.home)`), `launch`, `activate`, `wait:<s>`. Element queries are fine for
  verification (the perf driver avoids them only for CPU numbers). `typeText` can drop characters.
- **Bytes on the wire per app:** simulator apps are host processes; find the PID with
  `pgrep -f "Devices/<udid>/.*/<App>.app/<App>"` (not `Release-iphonesimulator`: installed apps run from
  `Containers/Bundle`) and sample `nettop -P -L 1 -p <pid> -J bytes_in,bytes_out -x`. rum-api's replay
  meta `bytes` is the gzip body as uploaded, so it splits replay from OTLP.
- **rum-api through Grafana:** the plugin's route is `/api/plugin-proxy/ouo11y-rum-app/rum/v1/...`
  (admin basic auth); `/api/plugins/ouo11y-rum-app/resources/...` answers 500.
- Replay frames come back from `/v1/sessions/{id}/replay/frames` as base64 JPEG with `ts` and `reason`
  (`resume`, `timer`, `touch`): read them to check masking frame by frame.

## Found on the way

- Input masking leaks on `touch` frames (typed text readable on the frame of a Back tap; `timer` frames
  around it are masked). Likely the view tree and the pixels (`drawHierarchy(afterScreenUpdates: false)`)
  come from different commits during a transition.
- npm fails inside `.claude/worktrees/*` while the founder's main checkout has conflict markers in
  workspace `package.json` files (see also [funnels.md](funnels.md)): `npm --prefix .`, or build in a copy
  outside the checkout.
