# Native iOS conformance suite

The suite of the native iOS package (`OuoSDK` in `sdk/ios`), with the check ids of
[docs/specs/mobile-sdk.md](../../../docs/specs/mobile-sdk.md) section 3 ([ADR-0015](../../../docs/adr/0015-mobile-sdk-spec-and-conformance.md)).
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
| [run.sh](run.sh) | builds the example and the tap runner, then the launches: the journey (through `proxy.mjs`) with a background stay past the 5 s timeout, the taps, a hang, a crash 3 s and one 200 ms after launch, a memory kill, an offline run; each followed by the launch that reports it |
| [check.mjs](check.mjs) | asserts rum-api (and Tempo through Grafana) per check, prints the checks and the maturity row |
| [proxy.mjs](proxy.mjs) | forwards OTLP to the collector and logs each request's `content-encoding` (C11.2) |
| [pixels.swift](pixels.swift) | C8.2's pixel check: composites the replay frames rum-api serves and measures the areas the example noted (a UIKit label, an input, a SwiftUI text, image and toolbar title), which must be black |
| [taps/](taps/project.yml) | the tap driver: an `xcodegen` project whose UI test drives the example by accessibility identifier (tap `open-products`, tap `add-to-cart`, long-press `checkout`, swipe `cart-items`) |

About 6 minutes, plus the first build. It needs `xcodegen` (Homebrew) and Docker for the stack.

**In CI** (checklist N78): the job `ios-native` of [ci.yml](../../../.github/workflows/ci.yml) runs
[ci.sh](ci.sh) on the Mac runner when `sdk/ios`, `examples/ouo-ios` or this suite change. The
runner's user cannot reach the Mac's Docker Desktop, so ci.sh builds the stack from the checkout in
a Lima VM of its own (`ouo-ci`, Docker inside, ports 29000..29099 forwarded to the Mac's loopback),
creates a new simulator, runs `run.sh - <udid>` against them, and deletes the simulator and stops
the VM on exit. Run it the same way locally, on your own VM name and port block:

```bash
OUO_NATIVE_VM=<you>-ci OUO_NATIVE_PORT_BASE=29200 perl -e 'alarm 3600; exec @ARGV' tests/e2e/mobile-native/ci.sh
OUO_NATIVE_VM=<you>-ci perl -e 'alarm 300; exec @ARGV' tests/e2e/mobile-native/ci.sh down   # if a run was killed
limactl delete <you>-ci                                                                      # the VM itself, when done
```

| File | What it does |
|---|---|
| [ci.sh](ci.sh) | CI's wrapper: the VM (created once, then started and stopped per run), the stack (`compose.yaml` plus [stack.compose.yaml](stack.compose.yaml)), a new simulator, `run.sh`, teardown |
| [stack.compose.yaml](stack.compose.yaml) | rum-api's replay chunks in a named volume: the VM mounts the home folder read-only |
