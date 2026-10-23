# Sentry client setup for the ouo bridge

For teams that keep `@sentry/react-native` and send its traffic through the ouo Sentry bridge (path 3, [ADR-0008](adr/0008-sentry-sdk-bridge.md), [spec](specs/sentry-bridge.md)). The bridge forwards every envelope to your Sentry unchanged and translates a copy into ouo, so most of this page is about the **traces between your app and your backend**, which only you can configure. The runnable reference is [`examples/sentry-mobile`](../examples/sentry-mobile/README.md); its `verify` checks every point below (checklist N24).

Supported SDK versions: [compatibility.md](compatibility.md#sentry-sdks-through-the-bridge).

## 1. Point the DSN at the bridge

```ts
Sentry.init({
  dsn: "https://<public key>@sentry-bridge.example.com/<sentry project id>",
  // ...
});
```

Same public key and project id as your Sentry DSN; only the host changes. The bridge's project table maps `(project id, public key)` to the ouo project and to your Sentry upstream. Nothing else in the SDK changes, and Sentry keeps receiving everything.

**Expo with @sentry/react-native 8: check that the native SDK starts.** The Expo config plugin writes a `sentry.options.json` when the plugin has `options`, or when `SENTRY_ENVIRONMENT` is set at prebuild. In a Release build the JS SDK then skips starting sentry-cocoa / sentry-android ("Using options file. Native SDK is expected to be initialized before JS") and expects your `AppDelegate` / `MainApplication` to start it (the plugin's `useNativeInit`). Without that native start, nothing is sent at all, to Sentry or to ouo. JS errors, transactions, sessions and replays all travel through the native transport. Either set `useNativeInit: true` in the plugin, or pass `autoInitializeNativeSdk: true` to `Sentry.init` as `examples/sentry-mobile` does.

## 2. Backend correlation: `propagateTraceparent` and `tracePropagationTargets`

Sentry propagates `sentry-trace` and `baggage` by default. An OpenTelemetry backend reads W3C `traceparent` only, so without it your backend starts a new trace for every request and ouo cannot join app and backend.

```ts
Sentry.init({
  // ...
  tracesSampleRate: 1.0,                              // section 3
  propagateTraceparent: true,                         // also send W3C traceparent
  tracePropagationTargets: ["https://api.example.com"], // your backends only
});
```

- `tracePropagationTargets` entries are substrings or regular expressions matched against the request URL. List **your backends only**. A broad entry such as `"localhost"` or `/.*/` also adds `traceparent`, `sentry-trace` and `baggage` to third-party APIs, which then fail CORS or leak your trace ids.
- The backend's CORS must allow `traceparent`, `tracestate`, `baggage` and `sentry-trace` (browsers and web views drop non-allowed headers silently). `examples/backend` shows the header list.
- This is an app change, so it ships with your next app release. Older releases keep sending `sentry-trace` only, and their backend traces stay separate.

## 3. `tracesSampleRate`: 1.0, or accept dropped backend traces

Sentry sets the sampled flag in `traceparent` from `tracesSampleRate`. Below 1.0, unsampled requests send `traceparent: 00-<trace>-<span>-00`. The OpenTelemetry SDK's default sampler (`ParentBased(AlwaysOn)`) honours that flag, so the backend **drops its spans for those requests**: no trace in Tempo, although the backend served the request.

Choose one:

- `tracesSampleRate: 1.0` (what the examples use): every request is traced on both sides. Sentry bills transactions, so check your quota. The bridge passes Sentry's `429` and `X-Sentry-Rate-Limits` back to the SDK unchanged.
- A lower rate, knowingly. ouo then shows backend traces only for the sampled share, and `trace_count` in ouo is lower than the request count.
- Keep the backend tracing everything whatever the client says, with a backend sampler that ignores the parent's flag (for example `AlwaysOn` instead of `ParentBased`). Backend traces are then complete, but unsampled requests appear as backend-only traces with an orphan parent span id: the app's span was never recorded.

## 4. Requests outside a transaction

When a request starts with no active span (no navigation, interaction or manual span running), Sentry still sends `traceparent`, with the propagation context's trace id and a **random parent span id that no span has**. In Tempo the backend span then hangs off a parent that never arrives ("missing root span").

- Keep `enableAutoPerformanceTracing` (default on) and React Navigation's integration so screens and their data loads are inside a transaction.
- Wrap requests started outside screens (timers, background sync, startup work before the first screen) in `Sentry.startSpan({ name, op: "task" }, () => fetch(...))`.
- `examples/sentry-mobile` starts every action in its own trace (`startNewTrace`) and its `verify` fails on any orphan parent.

## 5. Breadcrumbs: a `beforeBreadcrumb` filter

The bridge turns breadcrumbs into timeline events (spec section 9a). Filter what you do not want in either product, and always drop the ouo SDK's own uploads if ouo ever runs next to Sentry (section 6):

```ts
const OUO_HOSTS = ["otlp.example.com", "replay.example.com"]; // your ouo collector hosts

Sentry.init({
  // ...
  beforeBreadcrumb(crumb) {
    const url = String(crumb.data?.url ?? "");
    if ((crumb.category === "fetch" || crumb.category === "xhr") && OUO_HOSTS.some((h) => url.includes(h))) return null;
    if (crumb.category === "console" && crumb.level === "debug") return null; // noisy console output
    return crumb;
  },
});
```

Breadcrumb messages and `data` are app content: they reach Sentry and ouo as they are. Remove personal data here, before the SDK sends it.

## 6. Never send to the bridge while the ouo SDK also runs (parallel mode)

During a rollout from Sentry to the ouo SDK ([examples/sentry-mobile/ROLLOUT.md](../examples/sentry-mobile/ROLLOUT.md)), a device in the `parallel` cohort runs both SDKs. On those devices Sentry must use your **direct** Sentry DSN, never the bridge:

- The ouo SDK already reports the session to ouo. Through the bridge the same session would arrive twice, under two session ids.
- The ouo SDK, initialised after Sentry, owns `traceparent`, so Sentry adds none of its own. Bridged Sentry spans would then never be the backend span's parent, and ouo would show broken traces.

`examples/sentry-mobile` picks the DSN per cohort (`src/sentry.ts`). Its default build runs Sentry only (`OUO_RUM_MODE=sentry`), and its `verify` fails when a span of the other path appears in the window.

## 7. Session durations differ by about 30 s (C9)

The same use reads about 30 s shorter in Sentry and in ouo-through-the-bridge than in the ouo SDK:

- Sentry ends a mobile session at the moment the app goes to the background, and reports it as `exited` when the app returns. The bridge keeps Sentry's boundaries.
- The ouo SDK ends a session 30 s after backgrounding (`BACKGROUND_TIMEOUT`, [session lifecycle](specs/session-lifecycle.md)).

Observed: 36.6 s through the bridge against 67.3 s with the ouo SDK for the same journey. Compare durations within one path, not across paths. Session counts, crash-free and error rates are not affected.

## 8. Check your setup

Run your app's main flow, then in ouo:

- The session shows its requests, and each request's trace in Tempo has your backend's server span as a child of the app's `http.client` span.
- No backend span in that trace points at a missing parent.
- The backend's request count matches the traces.

The examples automate exactly this (`examples/tools/tracecheck.py`). Point it at your own stack:

```bash
python3 -I examples/tools/tracecheck.py --tempo <tempo url> --loki <loki url> --backend-url <backend url> \
  --client <service name the bridge gives your app> --path sentry --start <unix s> --end <unix s>
```

`--loki` needs your backend's per-request log line, as `examples/backend` writes it (`request` with `trace_id` and trace `flags`). Leave the option out otherwise.
