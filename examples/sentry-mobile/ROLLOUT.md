# Moving a React Native app from Sentry to ouo, one cohort at a time

This guide is for teams whose app ships `@sentry/react-native` today and who want to compare
ouo with Sentry on their own production traffic before they decide. One feature flag picks,
per device, which SDK records:

| Mode | Sentry SDK | ouo SDK | Where the data goes |
|---|---|---|---|
| `sentry` | on, DSN = the **ouo Sentry bridge** | off | Sentry gets every envelope, unchanged; ouo gets a translated copy |
| `parallel` | on, DSN = **Sentry directly** | on, replay **off** | Sentry from the Sentry SDK, ouo from the ouo SDK |
| `ouo` | **not initialised** | on, replay on | ouo only |

Every span and log record in ouo carries the resource attribute `ouo.rum.mode`, and every
Sentry event carries the tag `ouo.rum.mode`, so both sides can be split by cohort.

The working example is this app: `src/rollout.ts` (the decision), `index.ts` (launch order),
`src/sentry.ts`, `src/ouo.ts`, `src/monitoring.ts` (the app's own calls), `flags/` (flagd).

## The rules that make this safe

1. **Decide before any SDK starts, and never change your mind in the same process.**
   Both SDKs patch process-wide things that cannot be undone: the `ErrorUtils` global handler
   chain, Hermes' single promise rejection tracker, `fetch` and `XMLHttpRequest`, and on iOS
   the native crash handler and replay recorder. Turning an SDK off mid-session leaves those
   hooks behind, and turning one on mid-session misses the app start. The mode is therefore
   fixed per cold start: a new flag value applies at the **next** launch. Background and
   foreground do not re-evaluate anything.
2. **Do not wait for the network at launch.** Each launch applies the decision the previous
   launch stored (a synchronous file read), then evaluates the flag in the background and
   stores the answer for the next launch. Only the very first launch after install waits for
   the flag, for at most `flagTimeoutMs` (1.5 s in the example), and falls back to `sentry`.
   Offline launches keep the stored mode. The cost: a device changes cohort at its second
   launch after a flag change.
3. **Sticky per device.** The flag's `targetingKey` is a random id created on first launch and
   stored with the decision. A percentage rollout hashes it, so a device lands in the same
   cohort on every launch until you change the percentages.
4. **In `parallel` mode, Sentry must not go through the bridge.** The ouo SDK already reports
   those sessions; the bridge would report each one a second time. Keep both DSNs in the app:
   the bridge DSN for `sentry`, the original Sentry DSN for `parallel`.
5. **ouo initialises after Sentry** when both run, and forwards unhandled promise rejections to
   Sentry (Hermes keeps one tracker; the SDK initialised last owns it). Details:
   `project/kb/ouo-next-to-sentry.md`.
6. **ouo replay is off in `parallel`.** Sentry's replay keeps recording; two recorders double
   the capture cost on the device.

## Step 1: the flag

Any OpenFeature provider works. The example uses OFREP (the OpenFeature Remote Evaluation
Protocol, plain HTTP), which flagd serves and most flag vendors support, through
`@openfeature/web-sdk` + `@openfeature/ofrep-web-provider`. The web SDK is the right one for a
mobile app: its context is static (one device), and it evaluates synchronously once the
provider is ready. For tests without a server, `InMemoryProvider` pins a variant
(`OUO_FLAG_PROVIDER=memory OUO_RUM_MODE=parallel` in this app).

`flags/ouo-rum-mode.flagd.json` is the flag: older app versions (`appVersion < 1.0.0`) stay on
`sentry`, everyone else is split 80 / 15 / 5:

```json
"fractional": [
  { "cat": [{ "var": "$flagd.flagKey" }, { "var": "targetingKey" }] },
  ["sentry", 80], ["parallel", 15], ["ouo", 5]
]
```

Keep the variants in that order. Growing the rollout then only moves devices forward
(`sentry` → `parallel` → `ouo`): changing 80 / 15 / 5 to 70 / 20 / 10 moves the devices at the
70 to 80 % mark from `sentry` to `parallel` and those at 90 to 95 % from `parallel` to `ouo`.
Nobody goes back.

In a vendor (LaunchDarkly, Statsig, ConfigCat, Flagsmith, GrowthBook, ...): a string flag
`ouo.rum.mode` with the three variants, a percentage rollout on the targeting key, default
`sentry`. If the vendor has no OFREP endpoint, use its OpenFeature web provider instead; the
rest of this guide does not change. Run flagd locally:

```bash
docker compose -p ouo-flagd -f examples/sentry-mobile/flags/compose.yaml up -d
curl -s -X POST localhost:8016/ofrep/v1/evaluate/flags/ouo.rum.mode \
  -H 'content-type: application/json' -d '{"context":{"targetingKey":"device-1","appVersion":"1.0.0"}}'
```

## Step 2: the launch order in your app

Your entry file, in this order (see `index.ts`):

```ts
const launch = decideLaunch();                // stored decision, or (first launch) the flag
start(launch);                                // or `await` it on the first launch

function start({ mode }: Launch) {
  if (mode !== "ouo") initSentry(mode);        // DSN: bridge for "sentry", Sentry for "parallel"
  if (mode !== "sentry") initOuo(mode);        // after Sentry; replay only in "ouo"
}
registerRootComponent(Bootstrap);              // synchronously; renders null until started
```

- `registerRootComponent` must run while the bundle loads. On the first launch the root
  component renders nothing until the mode is known (at most the flag timeout).
- Wrap the root with `Sentry.wrap` only when Sentry runs.
- Exclude the flag request from tracing in both SDKs (`shouldCreateSpanForRequest` in Sentry,
  `tracing.ignoreUrls` in ouo): the background evaluation runs after the SDKs started.

`initSentry` (from `src/sentry.ts`):

```ts
Sentry.init({
  dsn: mode === "parallel" ? SENTRY_DSN : OUO_BRIDGE_DSN,
  initialScope: { tags: { "ouo.rum.mode": mode } },
  // ... your existing options
});
```

`initOuo` (from `src/ouo.ts`):

```ts
initRUM({
  // ... endpoint, projectId, projectToken, service
  resource: { "ouo.rum.mode": mode },
  replay: { enabled: mode === "ouo" },
  errors: mode === "parallel"
    ? { onUnhandledRejection: (e) => Sentry.captureException(e, { mechanism: { type: "onunhandledrejection", handled: true } }) }
    : {},
});
```

The bridge stamps `ouo.rum.mode = sentry` on everything it translates, so no app code is needed
for the `sentry` cohort.

## Step 3: your own Sentry calls

Without `Sentry.init`, every `Sentry.*` call is a no-op. Automatic capture (crashes, errors,
requests, navigation, sessions, replay) needs nothing, but calls you make yourself would vanish
for the `ouo` cohort and be Sentry-only in `parallel`. Send the ones that matter through a small
facade (`src/monitoring.ts`):

```ts
export function captureException(error: unknown, tags: Record<string, string> = {}) {
  ouo?.captureError(error, tags);
  return mode === "ouo" ? undefined : Sentry.captureException(error, { tags });
}
```

Leave `Sentry.startSpan`, `Sentry.logger` and breadcrumbs as they are: they are harmless no-ops
in `ouo` mode, and the ouo SDK traces requests and navigation on its own.

## Step 4: compare

ouo (Grafana Explore, Loki). Sessions per cohort over the last day:

```logql
sum by (ouo_rum_mode) (count_over_time({service_name=~"my-app|my-app-ouo", event_name="session.start"} [1d]))
```

Errors per session, per cohort:

```logql
sum by (ouo_rum_mode) (count_over_time({service_name=~"my-app|my-app-ouo", event_name="exception"} [1d]))
```

Tempo: `{ resource.ouo.rum.mode = "parallel" }`. Sentry: search `ouo.rum.mode:parallel`.

The fair comparisons:

- **`parallel` alone** answers "does ouo see what Sentry sees?": the same sessions, recorded by
  both SDKs at the same time. Compare error and crash counts, request failures, session counts.
- **`sentry` versus `ouo`** answers "what does it cost on the device?" (app start, memory,
  battery), because each device runs one SDK.
- Give the bridge cohort its own `service_name` in the bridge's project table (the example uses
  `sentry-demo` for the bridge and `sentry-demo-ouo` for the SDK), so ouo's session health
  pages can tell them apart before rum-api filters by cohort.

## Step 5: roll forward, or back

- Forward: raise the percentages. Each device changes cohort at its second launch after the
  change (the first launch fetches the value, the next one applies it).
- Back: set everything to `sentry`. Same delay. A crash loop in a cohort cannot be stopped
  faster than one relaunch, so watch the first hours of a step closely.
- Done: once every device is on `ouo` and the old app versions are gone, remove the Sentry SDK
  and the flag.

## Known edges

- **Reinstall = new bucket.** The bucketing id lives in the app's documents; a reinstall (or a
  cleared data container) draws a new one and may land in another cohort. Use your own stable
  install id as `targetingKey` if you have one that exists before any SDK starts.
- **Leaving Sentry leaves its last report on disk.** sentry-cocoa sends the end of a killed
  session (`abnormal`) and a native crash report at the next launch where Sentry runs. A device
  that moves to `ouo` never sends them; they sit in the Sentry cache until Sentry runs again.
  Moving from `sentry` to `parallel` is fine: observed, the previous session's end still reached
  Sentry through the bridge at the launch that fetched the new value.
- **Info messages through the bridge count as errors** (Sentry RN 8.30 attaches the stack as
  `exception.values`, and the bridge maps any event with exception values to `exception`), while
  the ouo SDK records `app.message` as a custom event. Compare error counts without messages.
- Native code that calls Sentry directly (an iOS or Android module) needs the same mode; read the
  stored decision there or skip it in `ouo` mode.

## What was verified (2026-10-17)

`examples/sentry-mobile` on the iOS 27 simulator against an isolated ouo stack built from this
branch, flagd v0.17.0, and sentrytap standing in for sentry.io behind both the bridge upstream and
the direct DSN (`scripts/rollout-journey.sh`, then `scripts/verify-rollout.py`):

| Cohort | Sentry received | ouo received | Checks |
|---|---|---|---|
| `sentry` (first launch, flag answered) | 24 envelopes via the bridge, tagged `sentry`, replay | 36 records, all `sentry-demo` / `ouo.rum.mode=sentry`; 7 traces; video replay | 12/12 |
| `parallel` (switched from `sentry`) | 23 envelopes direct, tagged `parallel`, replay; the rejection forwarded by ouo (`onunhandledrejection`) | 8 records, all `sentry-demo-ouo` / `parallel`, no bridge copy; 7 traces; no ouo replay | 12/12 |
| `ouo` (switched from `parallel`) | nothing | 8 records, all `sentry-demo-ouo` / `ouo`; 7 traces; frames replay | 10/10 |

Re-run after merging main (#24 navigation wiring, #25 perf harness) on the same setup: 12/12,
12/12, 10/10; the ouo cohorts now also record the `/Home` navigation from `onReady`.

Also: flagd stopped on a later launch keeps the stored mode; flagd stopped on a first launch
starts `sentry (default)` after the 1.5 s timeout; flagd's 80 / 15 / 5 split over 2,000 ids gave
79.1 / 15.9 / 5.1 % and the same answer for every id asked twice. Details:
`project/agents/sentry-demo/summaries/2026-10-17-rum-mode-rollout.md`, `project/kb/openfeature-rum-mode.md`.
