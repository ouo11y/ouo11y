# Native iOS conformance suite

The suite of the native iOS package (`OuoSDK` in `sdk/ios`), with the check ids of
[docs/specs/mobile-sdk.md](../../../docs/specs/mobile-sdk.md) section 3 ([ADR-0015](../../../docs/adr-archive/0015-mobile-sdk-spec-and-conformance.md)).
Unlike the React Native suite (`../mobile/`, a model in Node), it runs the real Swift code: the
example app [examples/ouo-ios](../../../examples/ouo-ios/README.md) on an iOS simulator, against an
`ouo-env` stack.

```bash
OUO_SESSION=<you> deploy/envs/ouo-env up <env>
xcrun simctl create ouo-native com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0   # then boot it
tests/e2e/mobile-native/run.sh <env> <simulator udid>
```

| File | What it does |
|---|---|
| [run.sh](run.sh) | builds the example and the tap runner, then the launches: the journey (through `proxy.mjs`) with a background stay past the 5 s timeout, the taps, a hang, a crash 3 s and one 200 ms after launch, a memory kill, an offline run, each followed by the launch that reports it; last a run whose first OTLP requests the proxy answers 500 and 503 (C11.3) |
| [check.mjs](check.mjs) | asserts rum-api (and Tempo through Grafana) per check, prints the checks and the maturity row |
| [proxy.mjs](proxy.mjs) | forwards OTLP to the collector and logs each request's `content-encoding` (C11.2) and body hash; `POST /__reject` makes it answer the first OTLP body 500 every time and the second 503 once (C11.3) |
| [pixels.swift](pixels.swift) | C8.2's pixel check: composites the replay frames rum-api serves and measures the areas the example noted (a UIKit label, an input, a SwiftUI text, image and toolbar title), which must be black |
| [taps/](taps/project.yml) | the tap driver: an `xcodegen` project whose UI test drives the example by accessibility identifier (tap `open-products`, tap `add-to-cart`, long-press `checkout`, swipe `cart-items`) |

About 6 minutes, plus the first build. It needs `xcodegen` (Homebrew) and Docker for the stack.

**Not in CI yet** (checklist N78): the macOS runners have a simulator but no Docker for an
`ouo-env` stack; the Linux runners that have Docker have no simulator. CI builds every target of `sdk/ios` for
the simulator (the Objective-C smoke included) and runs the unit tests; this suite is run by hand
before a release and by the package that changes the native SDK.
