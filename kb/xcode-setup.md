# Xcode setup for the iOS replay verification

Status: written in Phase 7 by `ios-replay`. This Mac (macOS 26.2, Apple silicon) has only the
Command Line Tools (Swift 6.3) and the Xcodes.app version manager; no `/Applications/Xcode.app`,
no `iphonesimulator` SDK, no CoreSimulator devices, no CocoaPods on PATH at the time of the
run. Everything below is what the user must do once; none of it was run by the agent (App Store
sign-in and `sudo` are out of an agent's reach).

## Question

What exactly is needed on this machine to compile the `OuoReplay` UIKit target, build the Expo
development client and check the replay in the simulator and in Grafana?

## Steps

1. **Sign in to the App Store** (App Store app > Sign In) with an Apple ID. `mas` needs it.
2. **Install Xcode** (either):
   - `mas install 497799835` (Xcode from the App Store, ~3 GB download, ~12 GB installed), or
   - Xcodes.app (already in `/Applications`): pick the latest release, Install; it downloads
     from Apple's developer site and asks for the Apple ID.
3. **Select it and accept the licence** (needs the admin password):
   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   sudo xcodebuild -license accept
   xcodebuild -runFirstLaunch
   ```
4. **iOS platform and simulator runtime**: `xcodebuild -downloadPlatform iOS` (several GB).
   Check: `xcrun --sdk iphonesimulator --show-sdk-path` prints a path and `xcrun simctl list
   devices available` lists iPhones.
5. **CocoaPods**: `brew install cocoapods` (no sudo; Homebrew builds Ruby, slow the first time).
   Check: `pod --version`.
6. **Swift package on iOS**:
   ```bash
   cd sdk/ios
   swift test                                   # XCTest/Swift Testing now come from Xcode
   xcodebuild -scheme OuoReplay -destination 'generic/platform=iOS Simulator' build
   ```
7. **Development client**:
   ```bash
   npm run -w sdk/react-native build            # also vendors the Swift sources into the pods
   cd examples/mobile
   npx expo prebuild --platform ios             # ios/ (gitignored) + pod install
   npx expo run:ios                             # builds, boots a simulator, starts Metro
   ```
   The stack must be up (`docker compose -f deploy/docker/compose.yaml up -d`); the simulator
   reaches the Mac as `localhost` (rum-api on 8080, OTLP on the port in `deploy/docker/.env`).

## Manual replay check list

1. With `debug: true` (`__DEV__`), Metro's log shows `[ouo] replay: started {...}` and Xcode's
   console `[ouo replay] frame timer … redacted rects`, then `queued session=… seq=0`,
   `uploaded seq=0`.
2. `curl -s localhost:8080/v1/sessions/<session id>/replay | jq` shows `kind: "frames"` and a
   growing `chunk_count`; the session id is in the header badge.
3. Navigate Products > Product > Add to cart > Checkout; type in the promo field. In Grafana
   (ouo RUM app > session > replay) the frames play with touch markers; all text, images and
   the promo field are black; the product title (`ouo-unmask`) is readable.
4. Chaos > "Replay pause/resume": the button label flips to `off`, no new `queued` lines appear
   while paused, one resume frame appears after resuming.
5. Background the app (Cmd+Shift+H): a final chunk is flushed; foreground: a `resume` frame.
6. Wait for a session rotation (or set `backgroundTimeoutMs` low and background > timeout): the
   new session's first chunk has `seq 0`.
7. Scrolling a list while recording must stay smooth (capture is ~10 to 30 ms per frame on
   a simulator; if it stutters, raise `frameInterval`).

## Known unknowns until this runs

- The UIKit target (`sdk/ios/Sources/OuoReplay`) and `ios/OuoReplayModule.swift` were written
  without compiling: expect small fixes (API availability, `Record` field syntax for the
  installed ExpoModulesCore version).
- Whether `drawHierarchy(in:afterScreenUpdates:false)` captures RN's Fabric surfaces and
  `react-native-screens` stacks completely; Sentry uses the same call, so it should.
- Capture cost on real devices; the 1000 px cap and quality 0.5 are the spec defaults.
