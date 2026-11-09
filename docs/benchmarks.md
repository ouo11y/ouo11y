# Device-cost benchmark: ouo SDK vs Sentry SDK

What the ouo SDK and the Sentry SDK cost on the end user's device, measured the same way for
every major release of `@ouo11y/react-native` against the latest stable `@sentry/react-native`.
Roadmap item B3 (`project/tracker/checklist.md` section 4). The rules in section 1 were written
before the first run (2026-10-23) and change only through a dated entry in section 7.

- Harness: [`examples/sentry-mobile/scripts/perf/`](../examples/sentry-mobile/scripts/perf/)
  (the PR #25 harness, extended).
- Results: one folder per run under
  [`project/reports/benchmarks/`](../project/reports/benchmarks/index.md), each with the raw
  JSON, the SDK configs used and a self-contained HTML report, plus a trend page across runs.
- Method notes and quirks: [`project/kb-archive/sdk-overhead-ios.md`](../project/kb-archive/sdk-overhead-ios.md).
- Workflow: [`.github/workflows/benchmark.yml`](../.github/workflows/benchmark.yml).

## 1. Fairness rules

1. **One app, one journey.** Every cell runs the same app (`examples/sentry-mobile`). The SDK mix
   and tier change per launch through `Documents/perf-mode.json`, so every cell runs the same
   binary and the same JS bundle. The journey is the same scripted sequence of **real taps**
   (XCUITest, fixed schedule from launch, coordinates rather than element queries). Every tap is
   checked to land by its backend request.
2. **Release builds** only: Release configuration, JS bundle embedded, no Metro, no debugger,
   SDK debug logging off.
3. **Sampling at 100 %** in every cell: traces, sessions, replays (session and on-error). A real
   deployment samples lower. 100 % is the worst case, and it makes both SDKs do the same work.
4. **Tiers compared separately.** A cell is (SDK, tier). Cells are only compared within a tier.

   | Tier | Sentry (`@sentry/react-native`) | ouo (`@ouo11y/react-native`) |
   |---|---|---|
   | **T1** errors | errors, native crashes, release-health sessions; tracing, logs and replay off | not available: ouo's fetch tracing cannot be switched off, so ouo's smallest setup is T2. The T1 table shows ouo's T2 numbers, marked as such. |
   | **T2** + tracing and network | T1 + `tracesSampleRate: 1`, navigation and fetch/XHR spans, trace propagation to the backend, structured logs | errors, crashes, sessions, navigation and fetch/XHR spans, propagation, logs |
   | **T3** + replay at defaults | T2 + `mobileReplayIntegration()` with no options (masking on, `replaysSessionQuality` medium) | T2 + `replay: { enabled: true }` with no other options (masking on) |
   | **T4** + replay at matched quality | T2 + replay at 1 frame/s, 1 px per point (quality `medium`), masking **off** | T2 + replay at 1 frame/s, 1 px per point (the default `maxLongestSide` 1000 gives 1 px/pt on every current iPhone), masking **off** |

   T4 makes both recorders capture the same pixels at the same rate and resolution. Masking off
   removes the differences between the two masking algorithms, and it is how the demo and the
   readable-replay setups run. The codecs stay as each SDK ships them: Sentry H.264 video, ouo
   JPEG frames. The configs used are written into every result folder (`configs/`).
5. **A no-SDK baseline** (`none`) in every round: the same binary with neither SDK started. Every
   cost is reported as the paired delta against it (same round), alongside the absolute numbers.
6. **N ≥ 10 runs per cell**, cells interleaved round-robin and rotated each round, so drift on
   the device or the host spreads over every cell. Reported: median and IQR (q1–q3) of each
   metric, and the paired median delta against `none` with its IQR.
7. **Each run starts cold**: app terminated, then reinstalled or its container wiped, so no
   queue, cache or session is left from the previous cell. On the device the reinstall is followed
   by one priming launch with no SDK that grants iOS's Local Network permission (asked again after
   every install; until answered, every request to the Mac is held), so the measured launch is the
   second launch after install, the same in every cell. On the device, run on a device that
   has been rebooted since the last build was installed, and leave it idle 2 min before the
   first round. One device and one OS per result. The device model, OS build, battery level,
   thermal state and Low Power Mode are recorded at the start and end.
8. **Pinned versions recorded** in `result.json`:
   - both SDK versions with their native parts (`sentry-cocoa`, `OuoReplay`);
   - React Native, Expo, Hermes, Xcode and iOS;
   - the app and harness git SHAs.

   Sentry is the **latest stable** `@sentry/react-native` at run time (`npm view
   @sentry/react-native version`, no pre-releases).
9. **Sentry configured per its own docs.** Options come from Sentry's React Native setup and
   Session Replay pages: `Sentry.init` with a DSN, `tracesSampleRate`, `enableLogs`,
   `replaysSessionSampleRate`, `replaysOnErrorSampleRate`, `mobileReplayIntegration()` and
   `reactNavigationIntegration()`. Nothing is tuned to make it cheaper or more expensive than
   a customer following those pages would get. The config of each tier is published with the
   result.
10. **Same network path for both.** Every request goes through the counting proxy
    (`proxy.py`) to a real stack (`ouo-env`). The Sentry DSN points at the stack's Sentry-compatible
    endpoint, so response codes, latency and retries are real for both SDKs. Nothing goes to
    sentry.io.
11. **Losses are reported as plainly as wins.** The report has no "ouo wins" summary. Each
    metric shows both numbers and the delta, colour-coded by sign only. Every cell where ouo
    costs more gets a one-line explanation in the report, or "unexplained". Simulator numbers are
    labelled **simulator-only** on every page that shows them, and never quoted as device numbers.
12. **Runs that did not do the work are left out and counted.** A run where an SDK the cell turns
    on sent no request at all (sentry-cocoa skips its native start silently when a Release build has a
    `sentry.options.json`), or where a recorder never uploaded a replay, or where the journey stopped
    before its 19th tap, would show that SDK cheaper than it is: it stays out of the
    cell's statistics. The report gives "runs in the statistics, X of N" per cell and lists every
    excluded run. A tap that missed (the run's backend requests differ from the usual run) is
    listed, not excluded.

## 2. Metrics

All metrics are from the app process, measured on the end device unless marked otherwise.

| Group | Metric | How |
|---|---|---|
| Network | bytes up on the wire (compressed as sent) and decoded (uncompressed), bytes down, request count, per destination | `proxy.py`, HTTP level (request line + headers + body); `Content-Encoding` decoded to get the uncompressed size |
| | replay bytes per minute | replay uploads only (ouo `/v1/replay/*`, Sentry envelopes with a `replay_video` item) over the run's minutes |
| CPU | average over the journey, p95 of 1 s windows, idle overhead (the 15 s idle tail after the last tap) | simulator: `proc_pid_rusage` from the host (`sample.py`); device: xctrace Activity Monitor (`device.py`) |
| Memory | peak, steady (median of the idle tail), growth over a 30 min soak (slope of a linear fit, MB/h) | phys_footprint, same sources |
| Disk | app binary added, JS bundle added | linker map of the Release build attributed per library; Metro bundle with source map attributed per package (`size.py`) |
| | on-disk queue and cache after the journey, maximum offline buffer | the app container after the run, by SDK directory; the offline cell runs the journey with the proxy refusing every SDK request, then measures the container |
| Startup | added startup | JS start to the first frame after `NavigationContainer.onReady`, delta against `none`. Process start to JS start is reported apart. |
| Frames | JS frames dropped and long JS frames (> 50 ms) | a 16 ms `setTimeout` heartbeat on the JS thread (`src/perf.ts`): every interval past one 60 Hz frame is a missed JS frame. Not `requestAnimationFrame`, which is `setTimeout(0)` in bridgeless React Native and busy-loops on a phone |
| | UI hitches | device: xctrace Hitches instrument in the same recording (`--power`) |
| Energy | energy impact | device only: xctrace Power Profiler instrument in the same recording (`--power`). The simulator's host-billed energy is not reported. |

## 3. Cells and run length

- Cells: `none`, `sentry-T1`, `sentry-T2`, `ouo-T2`, `sentry-T3`, `ouo-T3`, `sentry-T4`,
  `ouo-T4`: 8 cells × N = 10 rounds, 95 s each (journey 0–75 s, idle tail 80–95 s).
- Soak: `none`, `sentry-T3`, `ouo-T3`, 30 min each, journey repeated, 1 run per cell (memory
  growth only).
- Offline: `sentry-T3`, `ouo-T3`, one 95 s run each, proxy refusing SDK traffic.

### Phone budget (founder, 2026-10-23)

The founder's phone is used for only two short experiments. Everything else (network bytes, app size,
offline runs, soaks, crash flows, N ≥ 10 rounds of every tier) runs on the simulator.

| Phone experiment | One round, measured on 2026-10-23 (reinstall, priming launch, journey, recording, export) | Proposed |
|---|---|---|
| Replay capture cost, ouo and Sentry in one Time Profiler trace (`n22_device.py profile`) | 2.0–2.5 min per round per build | 3 rounds of one build: about 7 min |
| One run per cell for CPU, memory, app start and hitches (`bench.py --target device --power`) | 3.4–4.2 min per run (median 3.6) | the 8 cells once: about 30 min |

Device-only numbers are spot checks (n = 1 per cell), labelled as such. The N ≥ 10 rule stays with the
simulator run. Phone time per request: under 1 hour, including the founder's one Trust tap.
Before the next phone request: reset the app between runs without deleting it, so iOS asks for the
Local Network permission only once (today every reinstall asked again). That also saves about 40 s
per run.

## 4. Running it

Simulator (any Mac with Xcode; CI uses this):

```bash
deploy/envs/ouo-env up bench
examples/sentry-mobile/scripts/perf/bench.sh --env bench --target sim --runs 10
```

Device (manual only, CI has no phone; needs a signing Team ID):

```bash
deploy/envs/ouo-env up bench
examples/sentry-mobile/scripts/perf/bench.sh --env bench --target device \
  --device <udid> --team <TEAM_ID> --runs 10
```

`bench.sh` builds the app with the SDK versions given (`--ouo <ver|path>`, `--sentry <ver|latest>`),
starts the proxy, runs every cell, then writes
`project/reports/benchmarks/<date>-ouo-<ver>-vs-sentry-<ver>[-sim]/` (`result.json`, `configs/`,
`report.html`) and regenerates the trend page. The device steps (USB, unlocked, Auto-Lock off,
same Wi-Fi as the Mac) are in the kb entry.

## 5. Release gate (proposed, waiting for the founder's approval)

A major (or opted-in minor) release of `@ouo11y/react-native` runs the benchmark against the
previous released ouo version on the same machine in the same run. **The release is blocked**
when, in any tier, the new version's paired median delta against `none` is worse than the
previous version's by more than the threshold **and** the new median lies outside the previous
version's IQR (so noise alone cannot block):

| Metric | Threshold (worse by more than) |
|---|---|
| CPU average over the journey | 2 percentage points of one core, or 15 % |
| CPU idle overhead | 1 pp, or 15 % |
| Steady memory | 5 MB, or 10 % |
| Memory growth over the soak | 10 MB/h |
| SDK bytes up (wire) | 10 % |
| Added startup | 50 ms |
| JS frames dropped | 1 % of frames |
| App binary + JS bundle added | 10 % |
| Energy (device runs only) | 10 % |

Where both apply, the larger of the absolute and relative thresholds counts. The comparison
against Sentry never blocks a release. It is published, and a cell where ouo got worse against
Sentry since the last run gets a line in the release notes. The workflow reports the gate as a
failed check on the release PR. The founder can override it with a written reason in the PR.

## 6. Reading a result

Every result folder holds `result.json` (raw runs, per-cell summaries, paired deltas, versions,
device), `configs/` (the exact `Sentry.init` and `initRUM` options of each tier) and
`report.html`. The trend page (`project/reports/benchmarks/trend.html`) plots each tier's median
delta against `none` across runs, ouo and Sentry side by side.

## 7. Changes to the rules

- 2026-10-23: first version (B3).
