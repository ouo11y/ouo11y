# Browser SDK: architecture, configuration and sampling

- **SDK:** `@datadog/browser-rum` and `@datadog/browser-logs` **v7.17.0** (tag commit `df6c69bd`, released 2026-11-05). Research date 2026-11-10.
- **Shorthand:** `src:` = `https://github.com/DataDog/browser-sdk/blob/v7.17.0/packages/`
- Step 4 already lists the features: [datadog-web.md](../../../client-sdk-features/vendors/datadog-web.md). This page covers how the SDK is built and what each option does.

## Packages and how they fit together

| Package | Role | Source |
|---|---|---|
| `js-core` (internal) | Shared low-level code: endpoint builder and intake sites, time, `Observable`, DOM helpers, the config schema validator | `src:js-core/src/` |
| `browser-core` | Session store (cookie, localStorage or memory), batch, flush controller, HTTP transport and retry, telemetry, tracking consent, event bridge for WebViews | `src:browser-core/src/` |
| `browser-rum-core` | RUM domain: views, actions, resources, errors, long tasks, vitals, tracing, privacy, the event `LifeCycle` bus, assembly, plugins | `src:browser-rum-core/src/` |
| `browser-rum` | The public RUM entry point, plus two lazy chunks: the **recorder** (Session Replay) and the **profiler**. Also holds the deflate worker. | `src:browser-rum/src/` |
| `browser-rum-slim` | Same as `browser-rum` without the recorder and profiler | `src:browser-rum-slim/` |
| `browser-logs` | Logs SDK. It has its own session manager on the same cookie, and its own batch to `/api/v2/logs`. | `src:browser-logs/src/` |
| `browser-rum-react`, `-vue`, `-angular`, `-nextjs`, `-nuxt` | Plugins (router view names, error boundaries) on the `plugins` API | Step 4 FWK rows |

**Boot sequence:**
- `init()` validates the config against a declarative schema (`RUM_SCHEMA`, `src:browser-rum-core/src/domain/configuration/configuration.ts`).
- Public API calls made before the SDK starts are buffered, up to `BUFFER_LIMIT = 500` calls (`src:browser-rum-core/src/boot/preStartRum.ts#L62`).
- The SDK starts once tracking consent is granted and the (optional) remote configuration is loaded.

**Inside the SDK:**
- Collectors publish raw events on a `LifeCycle` bus (`src:browser-rum-core/src/domain/lifeCycle.ts`).
- `assembly.ts` adds the common context (session, view, user, account, global context, feature flags) and runs `beforeSend`.
- The batch dispatcher then sends events to the batch (`src:browser-rum-core/src/transport/startRumBatch.ts`).
- Plugins hook in at `onInit` and `onRumStart`. The plugin API is marked unstable.

**Threads and workers:**
- Everything runs on the main thread except compression.
- Deflate runs in a Web Worker built from an inline string through `URL.createObjectURL(new Blob([...]))`. Pass `workerUrl` under a strict CSP (`src:browser-rum/src/domain/deflate/deflateWorker.ts`).
- The worker is used for replay segments (always compressed) and for RUM batches when `compressIntakeRequests` is on.
- The recorder and profiler are ES dynamic-import chunks. They load only when replay or profiling is sampled in.
  - Observed: `bundle/chunks/datadogRecorder-*.js` and `datadogProfiler-*.js` in the npm tarball.

## Every init option

Defaults come from the schema objects, not from the docs. `BROWSER_CORE_SCHEMA` is in `src:browser-core/src/domain/configuration/configuration.ts`, `RUM_SCHEMA` in `src:browser-rum-core/src/domain/configuration/configuration.ts` (L483-L578), and `LOGS_SCHEMA` in `src:browser-logs/src/domain/configuration.ts`.

### Shared by RUM and Logs (browser-core)

| Option | Default | Effect |
|---|---|---|
| `clientToken` | required | Sent as `dd-api-key` in the URL. A public token, not a secret key. |
| `site` | `datadoghq.com` | Intake host becomes `browser-intake-<site with dots as dashes>`. Example: `datadoghq.eu` → `browser-intake-datadoghq.eu` (`src:js-core/src/transport/endpointBuilder.ts`) |
| `proxy` | — | A string becomes `<proxy>?ddforward=<url-encoded path+params>`. A function receives `{path, parameters, subdomain}`. |
| `service`, `env`, `version` | — (RUM: `service` defaults to `applicationId`) | Sent as the `ddtags` field inside each event, e.g. `sdk_version:7.17.0,env:local,…` (observed). They are no longer a URL parameter. |
| `sessionSampleRate` | 100 | Percent of sessions tracked. Deterministic from the session id (see Sampling). |
| `telemetrySampleRate` | 20 | SDK self-telemetry sent to Datadog on the `rum` track |
| `telemetryConfigurationSampleRate`, `telemetryUsageSampleRate` | 5, 5 | Internal |
| `trackingConsent` | `granted` | `not-granted` stops collection and expires the session |
| `sessionPersistence` | `cookie` | `cookie`, `local-storage`, `memory`, or an ordered array of fallbacks. Must be identical in RUM and Logs. |
| `trackSessionAcrossSubdomains` | false | Cookie on the parent domain |
| `useSecureSessionCookie` | false | `Secure` cookie |
| `usePartitionedCrossSiteSessionCookie` | false | `Partitioned; SameSite=None`, for iframes |
| `trackAnonymousUser` | true | `usr.anonymous_id`, kept in the session cookie for up to 1 year |
| `storeContextsAcrossPages` | false | Global and user context kept in localStorage |
| `allowUntrustedEvents` | false | Count synthetic (`isTrusted: false`) DOM events. Our capture used trusted CDP input. |
| `allowedTrackingOrigins` | — | Required to run inside browser extensions |
| `silentMultipleInit` | false | No warning on a second `init` |
| `beforeSend` | — | `(event, context) => boolean`. Can edit allowed fields or drop events (not views). |
| `source`, `sdkVersion`, `variant`, `replica`, `datacenter`, `enableExperimentalFeatures` | internal | `source` is `browser` / `flutter` / `unity` and sets `ddsource`. `replica` dual-ships to US1. |

### RUM only (browser-rum-core)

| Option | Default | Effect |
|---|---|---|
| `applicationId` | required | `application.id` on every event |
| `sessionReplaySampleRate` | 0 | Replay rate is a child rate: effective = session rate × replay rate / 100 (`correctedChildSampleRate`) |
| `startSessionReplayRecordingManually` | false | Sampled sessions wait for `startSessionReplayRecording()` |
| `defaultPrivacyLevel` | **`mask-user-input`** | Also `allow`, `mask`, `mask-unless-allowlisted`. The docs still say `mask` (see Step 4 RPL-g). |
| `enablePrivacyForActionName` | true | Action names follow the privacy level ("Masked Element", observed) |
| `sessionReplayCanvasRecording` | off | `{enable, quality}` with low, medium or high = 1, 4 or 8 fps. Needs experimental flag `session_replay_record_canvas`. |
| `profilingSampleRate` | 0 | JS Self-Profiling chunk |
| `traceSampleRate` | 100 | Child of the session rate; also reported as `_dd.rule_psr` |
| `allowedTracingUrls` | `[]` | Match options or `{match, propagatorTypes}`. Default propagators are `tracecontext` + `datadog`; `b3` and `b3multi` are opt-in. Needs `service`. |
| `traceContextInjection` | `sampled` | `all` also injects for unsampled traces |
| `propagateTraceBaggage` | true | `baggage: session.id=…,user.id=…` (observed) |
| `trackUserInteractions` | true | Click actions and frustrations |
| `actionNameAttribute` | — | Custom attribute name, in addition to `data-dd-action-name` |
| `trackResources` | true | Resource events from the Performance API plus fetch and XHR |
| `trackResourceHeaders` | off | `true` = 12 default response headers (observed: `content-type`, `cache-control`), or a `MatchHeader[]` |
| `allowedGraphQlUrls` | `[]` | GraphQL operation extraction, optional payload (32 KiB cap) |
| `trackLongTasks` | true | Long Animation Frames where supported (observed `entry_type: long-animation-frame`) |
| `trackViewsManually` | false | Views only from `startView()` |
| `excludedActivityUrls` | `[]` | Requests ignored when computing page activity (loading time, action end) |
| `trackFeatureFlagsForEvents` | `[]` | Add `feature_flags` to vital, action, long_task or resource (views and errors always get it) |
| `compressIntakeRequests` | false | Deflate RUM and Logs batches in the worker. Replay is always compressed. |
| `workerUrl` | — | Self-hosted worker for strict CSP |
| `betaEnableViewUpdates` | **true unless `proxy` is set** (or Salesforce build, or WebView bridge) | Send `view_update` diffs instead of full views (`isViewUpdatesEnabled`, L595-L620) |
| `betaTrackWebSockets` | false | WebSocket vitals |
| `subdomain` | — | Only changes the URL that `getSessionReplayLink()` returns |
| `plugins` | `[]` | `{name, onInit, onRumStart, getConfigurationTelemetry}` |
| `remoteConfiguration` | — (`@internal`) | `{id, sync?, required?}`: cached JSON from Datadog's CDN, refreshed in the background. `remoteConfigurationProxy` overrides the URL. |

### Logs only

| Option | Default | Effect |
|---|---|---|
| `forwardErrorsToLogs` | true | Uncaught errors and network errors become logs. Observed: our page's uncaught error, rejection and fetch 500 each became an `error` log. |
| `forwardConsoleLogs` | `[]` | `'all'` or a list of console levels |
| `forwardReports` | `[]` | Reporting API (CSP, intervention, deprecation) |
| `beforeSend`, `plugins` | — | As in RUM |

## Manual instrumentation API (RUM)

Source: `src:browser-rum-core/src/boot/rumPublicApi.ts`.

| Area | Calls |
|---|---|
| Views | `startView(name \| {name, service, version, context})`, `setViewName`, `setViewContext`, `setViewContextProperty`, `getViewContext`, `setViewLoadingTime()` (`addTiming` is older) |
| Actions | `addAction(name, context)`, `startAction` / `stopAction` |
| Errors | `addError(error, context)`. A `dd_context` property on the error is merged (observed: `context.component`). |
| Vitals | `startDurationVital(name, {vitalKey, context, description})` / `stopDurationVital(name, …)`, `addDurationVital`, `startOperation` / `succeedOperation` / `failOperation` |
| Resources | `startResource` / `stopResource` |
| Context | `setUser`, `setUserProperty`, `clearUser`, `setAccount…`, `setGlobalContext…`, `addFeatureFlagEvaluation` |
| Session | `stopSession`, `getInternalContext`, `setTrackingConsent` |
| Replay | `startSessionReplayRecording({force})`, `stopSessionReplayRecording`, `getSessionReplayLink` |

`startDurationVital` / `stopDurationVital` take the vital **name**, not a returned reference. Observed: a first demo version passed a reference, and no vital was sent.

## Sampling: how decisions are made and propagated

- **The session decision is deterministic.** Take the last UUID group of the session id as a 48-bit integer, multiply by the Knuth factor `1111111111111111111` mod 2^64, and keep the session if the result is ≤ rate × 2^64 (`src:browser-core/src/domain/sampler.ts`).
  - The same formula is used by Android, React Native's JS trace sampler and the dd-trace libraries (comment in `sampler.ts`; Android/RN in [android.md](../mobile-sdks/android.md)).
  - So a backend can recompute "would this session be sampled at rate X" from the id alone.
- **Child rates:**
  - Replay is `session × replay / 100`.
  - Traces are `session × trace / 100`, applied to the trace id (`src:browser-rum-core/src/domain/tracing/tracer.ts#L141`).
  - Replay and trace are therefore subsets of tracked sessions, never independent.
- **Where the decision lives:**
  - It is stored in the session cookie `_dd_s_v2` (`src:browser-core/src/domain/session/storeStrategies/sessionStoreStrategy.ts`).
  - An untracked session is stored as `'0'` (`SESSION_NOT_TRACKED`) and sends nothing.
- **What the backend sees:**
  - Events carry `_dd.configuration.session_sample_rate`, `session_replay_sample_rate`, `trace_sample_rate` and `profiling_sample_rate` (observed).
  - `session.has_replay` is set when the session records.
  - Replay can be forced on an unsampled session with `startSessionReplayRecording({force: true})` (Step 4 RPL-c).
- **Downstream propagation:**
  - Headers are `traceparent` / `tracestate: dd=s:1;o:rum` and `x-datadog-sampling-priority: 1` (observed, see [observed-behaviour.md](observed-behaviour.md)).
  - The trace id is 64-bit: the upper half of `traceparent` is zeros.

## Session lifecycle

- 15 min inactivity (`SESSION_EXPIRATION_DELAY`) and 4 h maximum (`SESSION_TIME_OUT_DELAY`). Cookie lifetime is 1 year (for the anonymous id) (`src:browser-core/src/domain/session/sessionConstants.ts`).
- Tabs share the session through the cookie.
- Activity extends the session, throttled to once per second.
- A visible tab re-checks the cookie every minute.
- When the session expires the batch is flushed with reason `session_expire` (`src:browser-core/src/transport/flushController.ts`).
- A renewed session starts a view with `loading_type: session_renewal` (Step 4 SES-a).
