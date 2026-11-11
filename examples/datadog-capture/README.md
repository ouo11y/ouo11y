# datadog-capture

Records exactly what the Datadog RUM SDKs send, without a Datadog account. Built for Step 6 vendor research (2026-11-10). The findings are in [project/kb/vendor-internals/datadog/](../../project/kb/vendor-internals/datadog/index.md).

- **Web:** `@datadog/browser-rum` + `@datadog/browser-logs` 7.17.0. The CDN-style `bundle/` files are served from `node_modules`; no CDN, no bundler. `proxy` points at the capture server.
- **iOS:** dd-sdk-ios 3.21.0 (SPM) in a small UIKit app. Each feature's `customEndpoint` points at the capture server.
- Fake ids only: application id `00000000-0000-4000-8000-000000000000`, client token `pub000…`. Nothing leaves the machine.

## Files

| File | What it does |
|---|---|
| `server.mjs` | No-dependency Node server on `127.0.0.1:4560`. Serves the page and SDK bundles. Stores every intake request in `captures/` as JSON (headers, query, decoded body) plus the raw `.bin`. Handles the browser `/intake?ddforward=…` and mobile `/api/v2/<track>`. Inflates deflate and gzip, splits NDJSON or JSON arrays, parses multipart, decodes replay segments. Also serves `/api/ok|fail|slow` and records their request headers (trace propagation). |
| `public/index.html`, `public/app.js` | Demo page: RUM, Logs and replay init, plus buttons for actions, dead and rage clicks, fetch, XHR, errors, logs, a long task, inputs with privacy attributes, DOM mutation, `pushState` navigation. Query toggles: `?compress=1`, `?viewUpdates=1`, `?replay=0`, `?privacy=mask`. |
| `drive.mjs` | Starts headless Chrome and clicks and types through the DevTools protocol (trusted events), then leaves the page to trigger the exit flush |
| `decode-change-snapshot.mjs` | Prints the nodes of a v7 "Change"-format replay full snapshot |
| `ios/project.yml`, `ios/Sources/App.swift` | xcodegen spec and app. `-autopilot` runs fetches, errors, logs, a custom action, a long task, text entry and a push/pop on a timer. |

## Run (web)

```bash
cd examples/datadog-capture
npm install                     # 2 deps, exact versions
CAPTURE_DIR=$PWD/captures/run1 node server.mjs &   # note the PID, kill it afterwards
node drive.mjs                  # or: node drive.mjs "compress=1&viewUpdates=1"
kill <server PID>
ls captures/run1
```

`drive.mjs` uses `/Applications/Google Chrome.app` by default. Set `CHROME=/path/to/chrome` to change it. It uses DevTools port 4561.

## Run (iOS simulator)

```bash
cd examples/datadog-capture/ios
xcodegen generate
xcodebuild -project DDCapture.xcodeproj -scheme DDCapture -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/dd-ios build
UDID=$(xcrun simctl create step6-datadog com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro)
xcrun simctl boot $UDID
xcrun simctl install $UDID /tmp/dd-ios/Build/Products/Debug-iphonesimulator/DDCapture.app
xcrun simctl launch $UDID dev.ouo.research.DDCapture -autopilot
# … wait about 60 s for uploads, then:
xcrun simctl delete $UDID
```

- The simulator shares the host network, so `http://127.0.0.1:4560` works. ATS is relaxed in `project.yml`.
- The iOS 27 SDK refuses to launch apps without the UIScene life cycle. The app has a `SceneDelegate` for that reason.

## Dependencies

- `@datadog/browser-rum` and `@datadog/browser-logs` 7.17.0: the SDKs under study.
- `dd-sdk-ios` 3.21.0 through SPM: the SDK under study.
- Nothing else. The server and driver use Node 24 built-ins only (`http`, `zlib`, global `WebSocket`).

`captures/`, `node_modules/` and the generated Xcode project are git-ignored. Redacted samples are committed as kb fixtures.
