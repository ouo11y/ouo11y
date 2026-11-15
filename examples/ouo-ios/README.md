# ouo-ios: the native iOS example

A UIKit app with a SwiftUI screen on the `OuoSDK` product of [sdk/ios](../../sdk/ios/README.md):
Home (UIKit, a screen by itself, reports full display), Products (SwiftUI, `.ouoScreen`, a masked
card with `.ouoMask()` and an unmasked total with `.ouoUnmask()`), Cart (UIKit: a promo code input,
a list to swipe, a checkout request inside a span). The shape of a new Xcode project (an app
delegate and a scene delegate), as a SwiftPM executable, so the repository needs no Xcode project.

```bash
scripts/build.sh /tmp/ouo-ios          # prints the .app; then xcrun simctl install <udid> <app>
SIMCTL_CHILD_OUO_OTLP=http://localhost:4318 SIMCTL_CHILD_OUO_ACTION=journey xcrun simctl launch <udid> dev.ouo.example.ios
```

Environment: `OUO_OTLP` (collector OTLP/HTTP), `OUO_REPLAY` (its replay receiver), `OUO_BACKEND` (the demo backend), `OUO_ACTION`
(`journey`, `taps`, `hang`, `crash`, `early`, `oom`, `offline`, `reject`, `bench`, `dump`), `OUO_OFF=1` (the
SDK not started), `OUO_TAP_LABELS=0`, `OUO_DEBUG=1`. The app writes its steps to
`Documents/journey.jsonl` for the suite's checker.

- The B3 cells: `scripts/bench.sh <env> <udid> <out> [rounds]` (`none` against `ouo`, paired
  medians by `scripts/bench.py`).
