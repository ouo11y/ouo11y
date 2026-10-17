# Device cost of @ouo/react-native next to @sentry/react-native on iOS (measured 2026-10-17)

Question: how much does an app on `@sentry/react-native` pay on the device when it adds
`@ouo/react-native`, with ouo replay off (the default, ADR-0006) and on? Report with charts:
`agents/sentry-demo/reports/sdk-overhead-ios.html`. Scripts: `examples/sentry-mobile/scripts/perf/`.

## Result (30 runs: 5 modes x 6 interleaved rounds, 95 s each, iOS 27 simulator on an M5 Mac)

No real device was available (`xcrun devicectl list devices` shows simulators only).

Paired deltas (same round, mode B minus mode A), median [min, max] of 6 rounds:

| | CPU journey (pp of a core) | CPU idle (pp) | steady MB | peak MB | start ms | SDK requests | SDK upload KB | JS frames dropped |
|---|---|---|---|---|---|---|---|---|
| Sentry + ouo (replay off) - Sentry | +0.1 [-0.7, +0.8] | 0.0 [-0.5, +0.6] | +0.6 [-0.1, +8.7] | +0.8 [-33.8, +2.9] | +2.5 [-50, +26] | +15 | +59 [+25, +118] | +1 [-5, +3] |
| Sentry + ouo (replay on) - Sentry | +6.6 [+4.4, +7.5] | +5.0 [+3.7, +5.2] | +1.0 | +0.5 | +93 [+39, +130] | +26 | +1080 [+776, +1155] | 0 |
| Sentry - no SDK | +9.6 [+7.3, +10.1] | +7.4 | +8.0 | +56.2 | +141 | +38 | +651 | +1.5 |
| ouo (replay on) - no SDK | +7.2 [+5.4, +7.6] | +5.5 | +0.3 | +10.1 | +99 | +26 | +1218 | 0 |

Mode medians: CPU 5.8 % (none), 15.4 % (Sentry), 15.1 % (both, replay off), 22.3 % (both, replay on),
13.3 % (ouo with replay). Steady footprint 52 / 60 / 61 / 61 / 52 MB.

- **ouo next to Sentry with replay off: no CPU, memory, start or JS-frame cost distinguishable from
  noise.** Its cost is network: 15 more requests per 95 s (batched OTLP exports, 53 KB) plus
  `traceparent`/`baggage` on every API call (backend requests 21.4 KB instead of 18.7 KB).
- **Two screen recorders** (ouo replay on next to Sentry's): +6.6 pp CPU, +5 pp even with nobody
  touching the app, ~1 MB more upload per 95 s (masking off), +93 ms start.
- **Main thread (Time Profiler, one both-replay run, `profile.py`)**: native Sentry code 33 % of sampled
  app CPU (`SentryGraphicsImageRenderer.image`, `SentryFileManager.write`, redaction), ouo
  `ReplayRecorder.captureFrame` 27 %, both on the main thread. One ouo capture holds the main thread
  ~49 ms (median of 89, p95 52 ms), Sentry's ~18.5 ms (median of 150, p95 41 ms). The simulator
  renders on the CPU and encodes Sentry's video with the software `H264SW.videocodec`, so both are
  overstated against a phone, but ouo's per-capture stall is the thing to check on a device first.
- Rounds 5 and 6 ran on a quieter host: every mode cheaper, process start to JS start 1.8 s instead of
  3.4 s. Hence paired deltas.

Claim text for clients: report "What the founder can say".

## Time Profiler attribution

```bash
xcrun xctrace record --template 'Time Profiler' --device <udid> --attach <pid> --time-limit 85s --output tp.trace
xcrun xctrace symbolicate --input tp.trace --dsym ios/build/DerivedData/Build/Products/Release-iphonesimulator/sentrydemo.app.dSYM --output tps.trace
xcrun xctrace export --input tps.trace --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > tps.xml
python3 -I scripts/perf/profile.py tps.xml
```

- Start the driver first, wait for the app pid (`pgrep -f 'sentrydemo.app/sentrydemo$'`), then attach.
- Without `symbolicate` the app binary's frames are bare addresses. Sentry and ouo are linked
  statically into `sentrydemo`, so classify by symbol: Sentry symbols contain "Sentry"; ouo's Swift
  types have no prefix (`ReplayRecorder`, `ScreenCapturer`, `ChunkUploader`, ...).
- Rows carry `tagged-backtrace` (not `backtrace`) in the Xcode 27 export, and every element can be a
  `ref` to an earlier `id`.
- XCUITest's own accessibility work inside the app (`XCTAutomationSupport`, `UIAccessibility`) was ~8 %
  of sampled CPU even with coordinate taps; the same in every mode.

## Method (repeatable)

**One binary, five modes.** `examples/sentry-mobile` built once with `OUO_PERF=1`. At start
`src/rollout.ts` reads `Documents/perf-mode.json` synchronously (expo-file-system `File.textSync`)
before `Sentry.init` and uses it instead of the `ouo.rum.mode` flag (nothing evaluated or stored,
so no flag request in the measurement), so the SDK mix changes per launch without a rebuild. Harness
mode -> file: `none` -> `{"mode":"none"}` (neither SDK started, the baseline), `sentry` ->
`{"mode":"sentry"}`, `both` -> `{"mode":"parallel"}` (ouo replay off), `both-replay` ->
`{"mode":"parallel","ouoReplay":true}`, `ouo-replay` -> `{"mode":"ouo"}` (Sentry linked but
`Sentry.init` never called: nothing native starts, zero Sentry requests verified). The numbers above
were measured on 2026-10-17 with the earlier `{"sentry","ouo","ouoReplay"}` file and the
`OUO_SDK=1` build flag; the SDK mixes are the same (since PR #23). Check after that change, one
round of the five modes on another simulator and stack (`ouo-flags`): every `perf.json` recorded the
intended mix, 19/19 steps per run, and the paired deltas fell where the 30-run medians are (both -
sentry CPU +0.3 pp, both-replay - both +4.2 pp, sentry - none +7.7 pp, ouo-replay - none +5.7 pp; one
round, so no spread). Same native
code, same JS bundle, same masking settings as the demo (masking **off** in both SDKs).

**Build** (proxy ports baked in; the isolated compose project `ouo-perf` behind them):

```bash
cd examples/sentry-mobile
OUO_PERF=1 SENTRY_DSN=http://publickey0000000000000000000000@localhost:4720/1 \
  SENTRY_DIRECT_DSN=http://publickey0000000000000000000000@localhost:4720/1 BACKEND_URL=http://localhost:4781 OUO_OTLP_ENDPOINT=http://localhost:4718 OUO_REPLAY_ENDPOINT=http://localhost:4719 \
  SIM_UDID=<udid> scripts/build-ios.sh
```

`SENTRY_DIRECT_DSN` is the DSN of `parallel` mode (`both`, `both-replay`); set it to the same proxy
port as `SENTRY_DSN` so every mode's Sentry traffic takes the same path, as in the measured runs.

**Stack**: `docker compose -p ouo-perf -f compose.yaml -f compose.images.yaml up -d --no-build` with
every `OUO_*_PORT` shifted (Grafana 3500, OTLP 4518, replay 4519, Sentry 4520, backend 8581, ...). The
demo backend image was re-tagged from an existing local build (`docker tag ouo-sb-backend:latest
ouo-perf-backend:latest`) because Docker Hub timed out on the `dockerfile:1` frontend. Real stack,
not a sink: response codes and latencies are the real ones, so SDK retry paths behave as in use.

**Proxy** (`proxy.py`): label:listen:upstream routes on both loopbacks (`127.0.0.1` and `::1`; the app's
`localhost` may resolve to either). Counts HTTP bytes as sent: request line + headers + body, and the
response. No TLS or TCP/IP overhead (plain HTTP to localhost); on a real network add TLS records and
headers, the same for every mode.

**Driver**: an XCUITest bundle in its own generated Xcode project (`make-driver.rb`, using the
`xcodeproj` gem that ships inside Homebrew's CocoaPods: `GEM_HOME=/opt/homebrew/Cellar/cocoapods/<v>/libexec
/opt/homebrew/opt/ruby/bin/ruby`). It reaches the app with `XCUIApplication(bundleIdentifier:)`, so the
app's Expo-generated project is untouched. 19 steps on a fixed schedule from the launch (taps on
product rows, Add to cart, Go to cart, header back buttons, Browse catalog, Search, Checkout, Fetch,
Fetch 500, XHR cart, Handled error, Message, two scrolls), then idle to 95 s.
- Taps go to **coordinates**, not element queries: every XCUITest element query makes the app build an
  accessibility snapshot, app CPU that is not the SDKs'.
- A drag of 300 pt moves a React Native ScrollView about **255 pt** (touch slop), even with
  `withVelocity: .slow, thenHoldForDuration: 0.4` (which does stop momentum). Calibrated from the backend
  log: the tap meant for "Fetch 500" hit "Fetch products" until the offsets were corrected. Check
  every tap lands by its backend request (`?fail=500` status 500, `GET /api/cart`, ...).
- `xcodebuild test-without-building -xctestrun ... -only-testing:PerfJourney/PerfJourneyUITests/testJourney`;
  `TEST_RUNNER_PERF_SECONDS=96` reaches the test as `PERF_SECONDS`.
- Real taps produce `ui.tap` breadcrumbs and replay touch events in Sentry (kb/sentry-replay-taps.md),
  which the deep-link journey (`journey.sh`) does not.

**Sampler** (`sample.py`): simulator apps are macOS processes, so the host reads the app's kernel
counters directly with `proc_pid_rusage(RUSAGE_INFO_V6)` via ctypes every 0.5 s: user + system CPU
time (mach ticks; multiply by `mach_timebase_info`, 125/3 ns on Apple Silicon), `phys_footprint`
(Xcode's memory gauge, jetsam), `lifetime_max_phys_footprint` (peak), `energy_nj`. Process start
from `proc_pidinfo(PROC_PIDTBSDINFO)` (`pbi_start_tvsec/usec` at offsets 120/128), microsecond
precision. Instruments' Activity Monitor reads the same counters. `proc_pid_rusage` can fail
transiently; check the pid is alive and skip the sample instead of stopping.

**JS frames** (`src/perf.ts`): a `requestAnimationFrame` loop (React Native's perf monitor idea), a
1 ms histogram of intervals in `Documents/perf.json` every 2 s. On the iOS 27 simulator rAF runs at
60 Hz (intervals 16-17 ms). Dropped = sum of `round(interval / 16.67) - 1`; long frames = intervals
over 50 ms. This is the JS thread only; UI-thread hitches are not measured.

**App start**: `jsStartMs` (first module evaluated, before `Sentry.init` and `initRUM`) to the first
rAF after `NavigationContainer.onReady`. Process start to JS start is reported apart: on the
simulator it is 2 to 5 s at ~100 % of a core with a 1-2 MB footprint (dyld_sim; under XCUITest it is
longer than with `simctl launch`), identical code for every mode and not representative of a phone.
CPU is therefore also counted from JS start.

**Per run** (`run.sh`): terminate, wipe the app's `Library/Caches`, `Library/Application Support`
and `tmp` (SDK queues, sessions, AsyncStorage: each run starts like a fresh install, no envelopes
left from the previous mode), write the mode, start the sampler, run the driver, copy `perf.json`.
Modes interleaved round-robin and rotated each round, so host drift spreads over every mode. Host
load average logged every 5 s next to the runs.

```bash
python3 -I scripts/perf/proxy.py --log <dir>/requests.jsonl --route backend:4781:8581 --route sentry:4720:4520 \
  --route otlp:4718:4518 --route replay:4719:4519 &
scripts/perf/run.sh --out <dir> --runs 6
python3 -I scripts/perf/analyze.py --runs <dir> --requests <dir>/requests.jsonl --json <dir>/summary.json
python3 -I scripts/perf/report.py --summary <dir>/summary.json --notes notes.html --out report.html
```

## Gotchas

- iOS crash reports from **other** simulators land in the same `~/Library/Logs/DiagnosticReports`
  (`sentrydemo-*.ips` from another session's native-crash test): check `procPath`'s device UDID.
- Use a dedicated simulator (`xcrun simctl create "ouo-perf iPhone 18 Pro" ...`): other sessions drive
  the shared one.
- `xcrun simctl io <udid> screenshot` works headless for calibrating coordinates (1206x2622 px = 402x874 pt).
