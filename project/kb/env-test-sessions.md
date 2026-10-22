# Real test sessions in an ouo-env without a phone or the simulator panel

Question: how does an agent get a real bridged (Sentry) session and a real ouo SDK session into its own
`ouo-env` env when the iPhone is taken and nobody is there to approve the simulator tool? Found while
verifying plugin 0.8.0 (grafana-plugin agent, 2026-10-23).

## ouo SDK session with real taps: the perf XCUITest driver

`examples/sentry-mobile/scripts/perf/driver` is an XCUITest that taps fixed coordinates on a schedule
(19 steps in 75 s: catalog, product, cart, checkout, fetch 500, handled error, message, two scrolls). It
injects real UIKit touches, so the ouo replay records touches and the app records taps, and it needs no
simulator panel or approval.

1. Own simulator: `xcrun simctl create ouo-<you> "iPhone 18 Pro"` then `xcrun simctl boot <udid>` (do not
   reuse a booted one: another session may be measuring on it).
2. Build the app with `OUO_PERF=1` and the env's ports (`ouo-env up` prints them), for example
   `SENTRY_DSN=http://publickey0000000000000000000000@localhost:<bridge> OUO_OTLP_ENDPOINT=http://localhost:<otlp>
   OUO_REPLAY_ENDPOINT=http://localhost:<replay> BACKEND_URL=http://localhost:<backend> OUO_FLAG_PROVIDER=memory
   OUO_PERF=1 scripts/build-ios.sh --device <udid>` (about 10 minutes the first time).
3. Build the driver once: `make-driver.rb` with the CocoaPods `GEM_HOME`, then `xcodebuild build-for-testing`
   with `-destination id=<udid>` (see `scripts/perf/run.sh`).
4. Per run: write `{"mode":"ouo"}` (or `sentry`, `parallel`) to the app container's
   `Documents/perf-mode.json`, wipe `Library/Caches`, `Library/Application Support` and `tmp`, run
   `xcodebuild test-without-building -only-testing:PerfJourney/PerfJourneyUITests/testJourney` with
   `TEST_RUNNER_PERF_SECONDS=90`, then put the app in the background (`xcrun simctl launch <udid>
   com.apple.Preferences`) for 45 s so the session ends and the replay flushes.

Result on 2026-10-23: an `errored` ouo session with a 73 s frames replay, 91 touches, 25 traces (all
`HTTP GET/POST` roots) and a handled error with its stack.

**Open:** the same build in `sentry` mode sent nothing to the bridge (no TCP connection to the bridge port,
no `Library/Caches/io.sentry`), although `perf.json` said `sentry: true` and the DSN in the bundle was right.
Not investigated further; the golden capture below was used for the bridged session instead.

## Bridged session: re-send a golden capture

`collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/*` are sentrytap captures
(`request.json` + `body.bin`, gzip) of real SDK runs. POSTing them in seq order to the env's bridge port
with the captured headers (drop `Content-Length`) recreates the session, its video replay with touches and
breadcrumbs, logs and an error. Three traps:

- **Loki rejects samples older than 168 h** (`reject_old_samples_max_age`), and one rejected entry fails the
  whole OTLP batch (43 records dropped). Only captures younger than 7 days work. `realtap/000001` carries a
  stale `abnormal` session update from two days before the capture: skip that request.
- **The bridge de-duplicates what it has seen, also across a collector restart.** A second send of the
  same capture is accepted (200) and translated to nothing. Re-key the copy: replace every UUID, 32-hex and
  16-hex id in the decompressed bodies with a consistent random id of the same shape (same length, so the
  msgpack replay items stay valid), gzip again. Each re-keyed send is a new session.
- **Old timestamps stay invisible until the ingester flushes.** Loki answers queries for ranges older than
  `query_ingesters_within` from the store only, so a session from six days ago is not in rum-api until its
  chunks are flushed: `curl -X POST http://loki.<env>.ouo.localhost/flush` (204), then it shows up.

Delay `**/replay/video/*` in Playwright (`page.route`, 1.5 s) to make the video player's segment loading
visible in screenshots; local segments otherwise load in a few ms.
