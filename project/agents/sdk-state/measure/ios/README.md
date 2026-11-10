# Step 5: iOS SDK overhead, ouo11y vs sentry-cocoa (simulator)

**Simulator-only numbers.** Every run here is on the iOS Simulator on an Apple-silicon Mac. A
simulator app is a host process: CPU and memory are the Mac's, not an iPhone's, and the network
path is loopback. Use these numbers to compare the two SDKs with each other, never as device
numbers. No physical iPhone was used.

**Host load.** A first run under heavy contention (1-min load 10 to 500, a parallel Android emulator) was discarded. The numbers in `results.json` come from a rerun on a quiet Mac (1-min load about 2 to 3), logged every 5 s by `scripts/loadlog.sh` and stored per run (`load1`) and per variant (`host_load1`).

**Journey n = 3.** 3 complete rounds (each variant 3 runs; a round takes about 10 minutes):
medians with min/max over 3 runs, not a robust spread. Init time has n = 12 per SDK variant.

## What is measured

One tiny app (`app/App.swift`: UIKit Home, a SwiftUI Products screen, a UIKit Cart screen),
compiled three ways from the same source:

| Build | Flag | SDK |
|---|---|---|
| `base` | none | no SDK linked |
| `ouo` | `-D OUO` | `OuoSDK` from `sdk/ios` (local path, version.txt 0.3.0), `Ouo.start` |
| `sentry` | `-D SENTRY` | sentry-cocoa **9.33.0** via SwiftPM, product `Sentry` (static xcframework, the default product) |

New dependency: sentry-cocoa 9.33.0, the latest 9.x tag at run time (2026-11-10), as the
comparison target. Nothing is added to the repository.

Five variants (core and replay share one binary; replay is a runtime switch):

| Variant | Config |
|---|---|
| `base` | no SDK |
| `ouo` | `OuoConfig` defaults + `propagateTo` the backend, `replaySampleRate 0` |
| `ouo_replay` | the same + `replaySampleRate 1` (defaults: masking on, `.auto` mode, which is `session` mode at 1 frame/s on the simulator because the host has more than 3.5 GiB RAM) |
| `sentry` | `dsn`, `tracesSampleRate 1`, everything else default (auto performance tracing, network tracking, crash handler, sessions) |
| `sentry_replay` | the same + `sessionReplay.sessionSampleRate 1`, `onErrorSampleRate 1` (defaults: masking on, quality medium) |

The journey (`STEP5_ACTION=journey`, driven by timers inside the app, so no taps are synthesised):
launch, 20 s idle on Home, then 60 s of 10 cycles (push Products + GET /api/products, +2 s push
Cart + GET /api/cart, +4 s POST /api/checkout and pop to Home), one handled error
(`Ouo.captureError` / `SentrySDK.capture(error:)`) in the first cycle, then idle. At 85 s the
harness brings Settings to the front (both SDKs flush on background), at 100 s the run ends.

## Method

- **Size** (`scripts/size.py`): Release builds through `xcodebuild` on a generated SwiftPM package
  (`scripts/build.sh`), wrapped into `Bench.app`. The main number is the **device build**
  (`-destination generic/platform=iOS`, `CODE_SIGNING_ALLOWED=NO`, arm64 only), ad-hoc signed: the
  `.app` uncompressed and as an IPA-shaped zip (`Payload/Bench.app`, deflate level 9). Also the
  executable after `strip -rSTx` (both SDKs link statically into the executable) and the simulator
  build (fat x86_64 + arm64, for reference only). This is not an App Store thinned size.
- **Init time**: `DispatchTime.now()` around `Ouo.start` / `SentrySDK.start` inside
  `didFinishLaunching`, on the main thread, written by the app to `Documents/step5.jsonl`. Each
  launch is a cold process launch on a fresh install (uninstall + install: empty container), 12
  launches per variant, variants interleaved round-robin and rotated per round, after one unrecorded
  warm-up launch per binary.
- **CPU and memory** (`scripts/sample.py`): `proc_pid_rusage(RUSAGE_INFO_V6)` on the app's PID
  (from `simctl launch`) every 0.5 s: user+system CPU time and `phys_footprint` (Xcode's memory
  gauge). Idle CPU = 5-20 s after process start, journey CPU = 20-80 s, both scaled to ms per
  minute. Idle memory = median footprint 10-20 s, journey = median 20-80 s, peak = max sample 0-85 s.
  Work done for the app by other processes (backboardd, the render server) is not counted.
- **Wire** (`scripts/capture.py`): one local server, four ports (+0 the app's own backend, +1 ouo
  OTLP, +2 ouo replay receiver, +3 Sentry, DSN `http://pub@127.0.0.1:47103/1`), answers 200 itself
  and logs every request: body bytes as sent (gzip as the SDK sent it), header bytes, decoded size,
  Sentry envelope item types. Wire per minute = every SDK request (not the app's own backend calls)
  from launch to the end of the run (100 s: 85 s foreground + 15 s background), scaled to 60 s.
- **Runs**: 3 journey rounds per variant, interleaved and rotated, each on a fresh install. A run
  is left out (and listed in `excluded_runs`) if its journey did not finish, an SDK variant sent
  nothing, or a replay variant uploaded no replay.

## Reproduce

```bash
W=<this folder>; REPO=<ouo repo root>
"$W/scripts/build.sh" "$REPO" 9.33.0          # builds base/ouo/sentry, writes build/sizes.json
UDID=$(xcrun simctl create step5-ios com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0)
xcrun simctl boot "$UDID"; xcrun simctl bootstatus "$UDID" -b
mkdir -p "$W/out"; "$W/scripts/loadlog.sh" >> "$W/out/load.log" &   # host load, every 5 s; kill its PID at the end
perl -e 'alarm 7200; exec @ARGV' "$W/scripts/run.sh" "$UDID" "$W/out" 12 3   # ~45 min on an idle Mac
python3 -I "$W/scripts/analyze.py" "$W/out" "$W/build/sizes.json" "$W/meta.json" > "$W/results.json"
xcrun simctl shutdown "$UDID"; xcrun simctl delete "$UDID"
```

`meta.json` holds the header fields (platform, device, host, versions, not_measured, method).

## Files

- `app/App.swift`, `app/Info.plist`: the harness app (one source, three builds).
- `scripts/build.sh`: generates `build/<variant>/pkg/Package.swift`, builds sim + device, wraps the `.app`.
- `scripts/size.py`, `scripts/capture.py`, `scripts/loadlog.sh`, `scripts/sample.py`, `scripts/run.sh`, `scripts/analyze.py`.
- `out/` (written by a run, not committed): raw data (`requests.jsonl`, `runs.jsonl`, `init/*.jsonl`, `journey/*.json` samples). `results.json` keeps every run's values.
- `results.json`: the numbers.
