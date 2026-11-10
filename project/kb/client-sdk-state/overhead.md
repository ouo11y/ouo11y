# SDK overhead and proposed budgets

What do the ouo SDKs cost in bundle size, CPU, memory and bytes on the wire, next to Sentry's on the same app and journey, and what budgets should fill [spec section 13](../opentelemetry/rum-semantic-conventions/sdk-spec.md#13-overhead-budgets)? Step 5, measured 2026-11-10. Charts with ranges are in the [report](sdk-state-report.html#overhead); harnesses and raw results in [`project/agents/sdk-state/measure/`](../../agents/sdk-state/measure/index.md).

## Setup

- One Apple M5 Mac (10 cores, 32 GB, macOS 27.0.1). Every platform has a no-SDK baseline in every round, variants interleaved, and costs are the variant's median minus the baseline median.
- **Web**: headless Chromium 156 (Playwright 1.64.1), a three-route shop page, 60 s of real clicks, typing, scrolling and fetches with one unhandled error, then page close. `@ouo11y/browser` 0.3.1 against `@sentry/browser` 11.11.0, both at 100 % sampling with default privacy. 5 rounds, plus 3 at 4x CPU throttling. Host load about 2.
- **iOS**: Simulator (iPhone 17 Pro, iOS 27.0). One UIKit/SwiftUI app built without an SDK, with `ouo11y-ios` 0.3.0 and with `sentry-cocoa` 9.33.0; replay is a runtime switch. 20 s idle then a 60 s timer-driven journey (screens, 30 HTTP calls, one handled error). 12 cold launches for init; 3 interleaved journey rounds; host load about 2 to 3.
- **Android**: emulator (API 35, arm64, 4 vCPU). One Kotlin app with R8 per variant. "ouo" is the Kotlin the React Native SDK vendors (signals and replay): `sdk/android` has no native exporter, so the ouo variants send replay only, while Sentry also sends errors, spans and sessions. 3 interleaved rounds; host load about 3 to 5. CPU counts the SDKs' own threads plus the main thread's increase: emulated graphics burn about 12 s per minute in every variant and swamp the total.
- **React Native**: JavaScript bundle size only. Its native parts are the iOS and Android code above.
- Simulator and emulator numbers are not device numbers: simulator CPU and memory are the Mac's, the emulator renders graphics in software.

## Results

### Size

| | ouo core | ouo + replay | Sentry core | Sentry + replay |
|---|---|---|---|---|
| Web, initial JS, gzip / brotli | 45.5 / 39.9 KiB | 45.5 / 40.0 KiB, plus a 57.6 KiB lazy rrweb chunk when sampled | 54.7 / 47.9 KiB (errors only: 31.3) | 95.1 / 82.2 KiB, all at load |
| iOS, zipped app delta | 375 KiB | same binary | 1309 KiB | same binary |
| Android, APK delta | 10 KiB (signals) | 42 KiB | 318 KiB | 379 KiB (1290 KiB with NDK) |
| React Native, JS gzip | 42.2 KiB | same | 109.0 KiB | same |

Web sizes are each variant bundled the way an app bundler would (esbuild, minified, code splitting). The published `dist/index.js` is 44.2 KiB gzip, exactly at its CI budget in `sdk/browser/size-budget.json`, so any new web feature needs headroom first.

### Runtime

| Added over no SDK | ouo core | ouo + replay | Sentry core | Sentry + replay |
|---|---|---|---|---|
| Web init, main thread (4x throttled) | 3.9 ms (17.9) | 4.0 ms (16.0) | 3.7 ms (14.3) | 7.2 ms (29.9) |
| Web renderer CPU, journey | 105 ms/min | 203 ms/min | 156 ms/min | 370 ms/min |
| Web JS heap after GC | 0.9 MiB | 2.5 MiB | 1.3 MiB | 2.7 MiB |
| Web p90 interaction task (4x) | +1.1 ms (+0.4) | +3.7 ms (+5.5) | +1.0 ms (+1.2) | +5.4 ms (+8.3) |
| Web bytes per minute: telemetry, replay | 30.7 KiB, 0 | 30.8, 19.9 KiB | 113.9 KiB, 0 | 119.9, 39.1 KiB |
| Web requests per minute | 30.8 | 40.7 | 27.8 | 36.8 |
| iOS init, main thread | 12.6 ms | 8.7 ms | 47.1 ms | 46.1 ms |
| iOS CPU, idle screen | 387 ms/min | 2476 ms/min | 429 ms/min | 4026 ms/min |
| iOS CPU, journey | 928 ms/min | 3076 ms/min | 662 ms/min | 3804 ms/min |
| iOS memory, steady / peak | 1.0 / 2.0 MiB | 1.3 / 3.8 MiB | 3.7 / 3.8 MiB | 9.2 / 42.5 MiB |
| iOS bytes per minute: all, of which replay | 28.2 KiB, 0 | 67.1, 38.8 KiB | 19.5 KiB, 0 | 69.4, 49.5 KiB |
| iOS requests per minute | 37.6 | 43.6 | 7.8 | 17.3 |
| Android init, main thread | 3.1 ms (signals) | 3.4 ms | 21.3 ms | 9.5 ms |
| Android CPU on SDK threads, journey | 30 ms/min | 290 ms/min | 70 ms/min | 350 ms/min |
| Android steady memory (PSS) | 1.3 MiB | 4.2 MiB | 6.0 MiB | 10.7 MiB |
| Android bytes per minute | 0 (no exporter) | 142 KiB, all replay | 20.7 KiB | 193 KiB |
| Android requests per minute | 0 | 11 | 9 | 23 |

No variant produced a long task (50 ms or more) on the web at either speed.

### What the numbers say

- **ouo is lighter than Sentry on most measures**: smaller on every platform (3.5x on iOS, 7.6x on Android, 2.6x in React Native JS), faster to init on iOS (12.6 against 47.1 ms) and Android, cheaper in web CPU (two thirds of Sentry core, about half with replay), far lighter in iOS replay memory (3.8 against 42.5 MiB peak), and cheaper on the wire on the web because ouo gzips telemetry and Sentry's browser envelopes go uncompressed. The Android comparison flatters ouo, which has no exporter there yet.
- **The exception is iOS core CPU**: 928 ms per minute in the journey against Sentry's 662. The likely cause is the next point.
- **ouo sends too many requests.** The web SDK sends about 31 telemetry requests a minute and iOS about 38: the exporters flush every one to two seconds while the app is active (`batchDelay` of 1 s on iOS). Sentry iOS sends 8. The spec's default `flushIntervalMs` of 5000 would cut this to at most 24 across the two queues.
- **An idle screen is not free on iOS.** ouo core costs about 387 ms of CPU per minute on a static screen (Sentry 429; no SDK 6), and replay 2476 (Sentry 4026). iOS replay takes and hashes a frame every second and drops it when nothing changed (`TileDiffer`, `sdk/ios/Sources/OuoReplayCore/TileDiffer.swift`); Android skips the capture when the window did not draw, and its replay on a static screen cost 60 ms per minute (no SDK 20, Sentry replay 719). iOS should skip the capture too.
- **Replay is where the cost is**, on every platform and for both vendors. ouo's web replay is a lazy chunk that only sampled sessions download; Sentry ships it in the main bundle unless the app lazy-loads the integration.

## JSON or protobuf for web telemetry

Spec section 8.1 leaves the web encoding to Step 5. The bodies of one ouo journey (31 requests, 53 records) were re-encoded as OTLP protobuf with a minimal encoder ([`json_vs_proto.py`](../../agents/sdk-state/measure/web/json_vs_proto.py)):

| | JSON | Protobuf | Ratio |
|---|---|---|---|
| Raw | 96.7 KB | 46.2 KB | 0.48 |
| gzip -9 | 28.4 KB | 26.5 KB | 0.93 |
| Serializer in the bundle, gzip | 3.1 KB | 5.3 KB | +2.1 KB |

After gzip, protobuf saves 7 %, about 2 KB a minute on this journey, for 2.1 KB more bundle. It halves the bytes only where the body cannot be compressed: the page-close flush, which TRN-2 allows uncompressed and which counts against the 60 KiB keepalive budget. **Recommendation for Step 7: keep JSON with gzip for web telemetry**, and revisit only if unload flushes hit the keepalive budget. Replay chunks stay binary protobuf as TRN-1 requires, because base64 in JSON costs 4/3.

## Proposed budgets for section 13

Proposals for Step 7, not decisions. Each sits above what ouo measures today with room for the spec work to come (consent, sanitiser, view ids, bypass set, OTLP replay, a native Android exporter), and below Sentry where Sentry is heavier. "Today" is ouo now; a budget ouo fails today is marked.

| Budget | Web | iOS | Android | React Native | Basis | Enforced by |
|---|---|---|---|---|---|---|
| Size, core (compressed) | 50 KiB gzip initial JS (today 45.5) | 500 KiB zipped app delta (today 375) | 250 KiB APK delta, exporter included (today 42 without one) | 50 KiB gzip JS (today 42.2), plus the iOS and Android native budgets | Sentry: web 54.7, iOS 1309, Android 318, RN JS 109. Room for consent, sanitiser, view ids, bypass set and, on Android, an OTLP exporter | CI on every PR: bundle.mjs (web, RN) and the iOS and Android harness builds plus size scripts. Fail above budget. The web dist budget (sdk/browser/size-budget.json) stays as the first gate |
| Size, with replay | 115 KiB gzip incl. the lazy replay chunk (today 103.1) | same binary as core (today 375) | 300 KiB APK delta (today 42) | native budgets apply | Sentry: web 95.1 all eager, iOS 1309, Android 379. Web replay must stay a lazy chunk, loaded only when sampled | Same jobs as core size. The web job also fails if the initial chunk contains rrweb |
| Init on the main thread | 10 ms (today 3.9); 30 ms at 4x CPU throttling (today 17.9) | 25 ms simulator (today 12.6) | 25 ms emulator (today 3.4 with replay) | not measured; propose 25 ms JS init | Sentry: web 3.7 core, 7.2 replay; iOS 47.1; Android 21.3 core, 9.5 replay. LIF-2 already forbids waiting on storage or network | Harness: performance.now / DispatchTime / elapsedRealtimeNanos around init, median of at least 10 cold starts. Web on every PR; mobile at release checkpoints in benchmark.yml |
| CPU, core, reference journey | 150 ms/min renderer CPU added (today 105) | 1000 ms/min journey, 300 ms/min idle screen (today 928 and 387: idle fails) | 200 ms/min on SDK threads (today 30, signals only) | not measured | Sentry: web 156; iOS 662 journey and 429 idle; Android 70. ouo iOS costs more than Sentry in the journey. An idle screen should cost close to nothing | Harness deltas against the no-SDK run in the same round, 5 rounds. Web on every PR on the self-hosted Linux runner; mobile at checkpoints. Fail on the median |
| CPU, replay on | 300 ms/min (today 203) | 3500 ms/min journey, 1000 idle (today 3076 and 2476: idle fails) | 600 ms/min on SDK threads (today 290) | follows iOS and Android | Sentry: web 370; iOS 3804 journey and 4026 idle; Android 350 | Same as core CPU |
| Memory added, steady and peak | JS heap after GC: 2 MiB core, 4 MiB replay (today 0.9 and 2.5) | peak footprint: 5 MiB core, 20 MiB replay (today 2.0 and 3.8) | steady PSS: 5 MiB core, 15 MiB replay (today 1.3 and 4.2) | not measured | Sentry: web 1.3 and 2.7; iOS 3.8 and 42.5 peak; Android 6.0 and 10.7 steady | Harness: forced GC then heap (web), phys_footprint (iOS), smaps_rollup PSS (Android), against the no-SDK run |
| Bytes per minute, telemetry | 40 KiB/min and 24 requests/min (today 30.7 KiB, 30.8 requests: requests fail) | 40 KiB/min and 24 requests/min (today 28.2 KiB, 37.6 requests: requests fail) | 40 KiB/min (no exporter today) | 40 KiB/min, not measured | Sentry: web 114 KiB (envelopes uncompressed) and 27.8 requests, iOS 19.5 KiB and 7.8 requests, Android 20.7 KiB and 9. 24 requests is two queues flushed every 5 s (spec 8.1 default) | Fake collector in the harness counts request bodies as sent. Wire scenario in the section 14 suite on every PR |
| Bytes per minute, replay | 60 KiB/min (today 19.9) | 100 KiB/min (today 38.8) | 200 KiB/min (today 142) | follows iOS and Android | Sentry: web 39.1, iOS 49.5, Android 193. The reference journeys are light; a 10,000-node page cost about 250 KiB/min on the web in the archived benchmark | Same as telemetry bytes |
| Persisted storage cap | 5 MiB IndexedDB, replay first to go (today 5 MiB, shared) | 5 MiB telemetry plus 10 MiB replay (today the same) | 10 MiB replay (today 10); 5 MiB telemetry when an exporter exists | 5 MiB outbox plus 10 MiB native replay (today the same) | 10 MiB holds over an hour of replay at the measured rates. Fills transport.persist.maxBytes in spec 8.1 | Unit test of the default and of oldest-first eviction in the order TRN-14 gives |
| Main-thread blocking per interaction (web) | SDK adds at most 2 ms core and 5 ms replay to the p90 interaction task; 4 ms and 10 ms at 4x throttling (today 1.1 and 3.7; 0.4 and 5.5) | n/a | n/a | n/a | Sentry: 1.0 and 5.4; 1.2 and 8.3 at 4x. INP's good threshold is 200 ms; the SDK should use a small slice of it | Chrome trace in the web harness: the task that dispatched each input event, against the no-SDK run |

### How CI enforces them (OVH-1)

- **Size, every PR.** `bundle.mjs` and `rn-bundle.mjs` for web and React Native; the iOS harness build (`generic/platform=iOS`, release) and the Android harness `assembleRelease` with their size scripts. They need no simulator or emulator. Fail above budget. The existing `npm run size:check` stays as the cheap first gate.
- **Web runtime, every PR.** `run.mjs` on the self-hosted Linux runner, 5 rounds against the no-SDK page in the same job, so runner speed cancels out. Fail when a median exceeds its budget.
- **Mobile runtime, at release checkpoints.** The iOS and Android harnesses in `.github/workflows/benchmark.yml` (macOS for the simulator; a Linux runner with KVM for the emulator). Simulator runs take about 45 minutes, too slow for every PR. Fail above budget or on a regression of more than 15 % from the previous checkpoint.
- **Storage cap.** A unit test per SDK of the default and of oldest-first eviction in the TRN-14 order.
- **Device runs** stay outside CI: one iPhone run per release checkpoint, counted against the founder's device budget, calibrates the simulator numbers.

## Earlier numbers, checked

`project/kb-archive/` and old benchmark docs were not taken as truth. Re-measured:

- Web core bundle "at its budget": confirmed. The archived benchmark had 45.3 KiB eager; this one 45.5. Its lazy chunk was 79.5 KiB; the shipped one is now 57.6 (rrweb patched and minified with terser).
- Archived web runtime (heavier page, 9 rounds, host load 15 to 25): ouo's journey CPU cost was below Sentry's with replay and similar without. Same direction here, on a quiet host.
- Archived wire numbers: ouo telemetry about 34 KiB/min, Sentry about 150 KiB/min. Here 31 and 114 on a lighter page. Same direction.

## Not measured

- **Web on Firefox and WebKit**: The harness ran Chromium only; the CDP metrics it reads do not exist elsewhere
- **React Native runtime cost**: Measuring it needs a release build of the Expo example app on a simulator and emulator, which did not fit this step. The JS bundle and the native pieces (iOS and Android harnesses) were measured separately
- **Real devices**: No phone was used. Simulator CPU and memory are the Mac's; the emulator renders in software
- **Web resource timing pricing (SIG-17)**: The SDK emits no browser.resource_timing events today; initial resources go out as resourceFetch child spans of documentLoad, always on, and are inside the measured telemetry bytes. Step 12 should price the event once it exists
- **Journey spread at n>=5**: 3 journey rounds per variant (each round takes about 10 minutes on the simulator); medians with min and max over 3 runs
- **App Store thinned / compressed download size**: no signing identity or App Store Connect; reported the unsigned device-arch (arm64) .app plus an IPA-shaped zip instead
- **Tap/interaction capture cost**: the journey is timer-driven inside the app (no synthesised touches), so neither SDK's tap tracking ran
- **Work done for the app by other processes (backboardd, render server, simulator networking)**: proc_pid_rusage counts the app process only
- **ouo Android handled-error capture, HTTP spans, traces/logs/metrics export (OTLP) in the native host**: sdk/android has no native init, exporter or handled-error/HTTP API today; in the React Native SDK those live in JS (@ouo11y/react-native) and only replay + signals are native. The ouo variants therefore send replay chunks only; the handled error and the 3 HTTP calls per Fetch produce no ouo telemetry, while Sentry reports them (error event, OkHttp spans, transactions, sessions). Wire and CPU deltas are not like-for-like on that part.
- **ouo signals' wire cost (crash / hang / termination reports)**: Signals writes crash.json/run.json and hands the previous run's report to the host at the next launch; the native host has no sender (the RN JS SDK sends it). No crash or hang was provoked in the journey.
- **ouo full SDK as shipped (React Native app examples/ouo-mobile: JS SDK + native replay + signals)**: Not run: an RN app's own baseline (Hermes, RN runtime) would swamp a native comparison against sentry-android, and building the Expo example (prebuild + C++ build) was out of the time budget of this step. The native host measures exactly the Kotlin code the RN SDK vendors.
- **Runtime cost of sentry-android with NDK (variant sentryfull)**: Measured for size only; the NDK handler adds a native crash handler, not per-minute work, and the runtime runs cover sentry-android-core (+replay).
- **Frame timing (jank) impact via dumpsys gfxinfo, and simpleperf profiles**: Not collected: with emulated GL the frame times reflect the emulator, not the SDKs; per-thread /proc CPU attribution is used instead.
