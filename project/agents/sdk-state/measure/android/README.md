# Android overhead harness

ouo's Android code against sentry-android 8.63.0 in one native Kotlin app on an Android emulator. Written for Step 5 ([overhead.md](../../../../kb/client-sdk-state/overhead.md)); [results.json](results.json) holds the numbers the report uses.

## What "ouo on Android" means here

`sdk/android` has no native init, session or exporter: the React Native SDK supplies those in JavaScript. The harness therefore measures exactly the Kotlin the React Native SDK vendors: `Signals` (crash, hang and termination capture, frame metrics) and `OuoReplay` (screenshot replay, sent to `/v1/replay/chunks`). The ouo variants send replay only; the handled error and the HTTP calls produce no ouo telemetry, while Sentry reports them. Size and runtime are therefore a lower bound for a future native ouo SDK.

| Flavor | Contents |
|---|---|
| `baseline` | No SDK. OkHttp 4.12.0 in every flavor |
| `ouosignals` | `Signals.init` and `install` |
| `ouofull` | Plus `OuoReplay.start`, session mode, 1 s frame interval, default masks |
| `sentrycore` | `sentry-android-core` plus `sentry-okhttp`, `tracesSampleRate = 1.0` |
| `sentryreplay` | Plus `sentry-android-replay`, `sessionSampleRate = 1.0` |
| `sentryfull` | The `sentry-android` umbrella with NDK, for size only |

Both SDKs are initialised by hand in `Application.onCreate`; `init_ms` is the wall time of that call.

## Journey and metrics

Cold launch (`am start -W`), 8 s settle, 30 s idle on a static screen, then 60 s of scripted `adb input`: four 15 s cycles of a fetch (2 GET and 1 POST to the capture server), a 300-row list flung three times, a detail screen and another fetch, with one handled error in the first cycle; then 10 s grace. Variants run round-robin within each round.

| Metric | How |
|---|---|
| Size | APK file size and uncompressed entries minus `baseline`, release with R8 and resource shrinking, arm64-v8a only ([scripts/sizes.py](scripts/sizes.py)) |
| CPU | `utime + stime` per thread from `/proc/<pid>/task/*/stat` (root). The report counts the SDKs' own threads plus the main thread's increase over `baseline`: emulated graphics (`RenderThread`, SwiftShader) burn about 15 s per minute in every flavor and swamp the total |
| Memory | `Pss` from `/proc/<pid>/smaps_rollup` after settle (idle) and the maximum of five samples during the journey (peak) |
| Bytes | Request bodies as sent (both SDKs gzip) received by [scripts/capture_server.py](scripts/capture_server.py) on port 8712, journey start to end of grace, per minute |
| Host load | The Mac's load average every 10 s ([scripts/load_sampler.sh](scripts/load_sampler.sh)), joined to each run |

## Run it

From this folder, on a Mac with the Android command-line tools under `/opt/homebrew/share/android-commandlinetools`:

```bash
scripts/vendor.sh ../../../../..        # copies sdk/android's four modules and the Gradle wrapper into host/
(cd host && ./gradlew assembleRelease)
python3 scripts/sizes.py
scripts/avd.sh                          # once: creates the AVD ouo-step5-bench (API 35, 4 vCPU, 4 GiB)
```

Then boot the AVD headless, keep its PID, and drive it:

```bash
emulator -avd ouo-step5-bench -no-window -no-audio -no-snapshot -gpu swiftshader_indirect &
adb -s emulator-5554 wait-for-device && adb -s emulator-5554 root
for f in host/app/build/outputs/apk/*/release/*.apk; do adb -s emulator-5554 install -r "$f"; done
python3 scripts/capture_server.py out/capture.jsonl &
scripts/load_sampler.sh > out/load.jsonl &
python3 scripts/run_bench.py emulator-5554 3 baseline ouosignals ouofull sentrycore sentryreplay
python3 scripts/analyze.py
adb -s emulator-5554 emu kill
```

Stop the capture server and the load sampler by the PIDs you started. On the Mac, bound each long command with `perl -e 'alarm 3600; exec @ARGV'`.

## Limits

- Emulator, not a phone: graphics are emulated, Sentry's MP4 replay encoder runs in software, and there is no battery or frame-time measurement.
- Three rounds per flavor. Medians are indicative; `results.json` has min and max per metric.
- No crash or hang is provoked, so the cost of sending those reports is not measured.
