# @ouo11y/browser

The ouo Real User Monitoring SDK for browsers, built on the OpenTelemetry API and SDK. It observes one page and sends what it sees as OTLP/HTTP to an OpenTelemetry Collector: sessions, errors, web vitals, clicks and frustration signals, navigation, traced requests, and masked session replay.

It implements the ouo client SDK spec, spec version `0.1.0-draft` ([sdk-spec.md](../../project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md)). Requirement ids such as `SES-4` in this file and in the source point at that spec.

**The golden rule: the app must not pay for the SDK's failures.** No public function throws, every hook contains its own errors, patched functions behave like the originals, and after 20 internal errors the SDK turns itself off. [Compatibility and safety](#compatibility-and-safety) says how that is tested.

## Install and start

```bash
npm install @ouo11y/browser
```

```ts
import { init } from "@ouo11y/browser";

init({
  endpoint: "https://otel.example.com", // the Collector's OTLP/HTTP base URL, or a same-origin path such as "/otel"
  projectId: "demo", // shorthand for headers.Authorization = "Basic base64(projectId:projectToken)"
  projectToken: "pt_public_token",
  serviceName: "web-store",
  serviceVersion: "1.4.2",
  environment: "production",
  replay: { sessionRate: 0.1 }, // record one session in ten
});
```

Call `init` once, as early as possible. It never throws and returns without waiting for storage or the network. With a missing or unusable `endpoint` or `serviceName` the SDK is a no-op; any other bad value falls back to its default (out-of-range numbers are clamped), with one diagnostic per key when `debug` is on. On the server (no `window`) every function is a no-op, so the package can be imported from code that also renders on the server.

## API

Every function is safe to call before `init`, after `shutdown`, on the server and with any argument: it is then a no-op and never throws.

| Function | Effect |
|---|---|
| `init(config)` | Start the SDK. A second call is ignored |
| `shutdown()` | Stop capture, remove every hook, end the session, flush within `transport.shutdownDeadlineMs`. `init` may be called again |
| `flush()` | Export what is queued. Resolves when done or on the deadline; never rejects |
| `getSessionId()` | The current session id, or `undefined` |
| `restartSession()` | End this session and start a new one |
| `setUser(id \| null)` | Set or clear `enduser.id`. A different user starts a new session |
| `setConsent({ telemetry?, replay? })` | Update consent. Only the keys given change |
| `setGlobalAttributes(map)` | Attributes for every later record. Replaces the previous set |
| `recordEvent(name, attributes?, body?)` | A custom event |
| `recordException(error, attributes?)` | A handled error. Attributes may include `ouo.exception.fingerprint` and `ouo.exception.handled` |
| `trackNavigation(name, { url?, id? })` | Declare a soft navigation the SDK cannot see, or name the one it just saw (a route template) |
| `getTracerProvider()`, `getLoggerProvider()` | The SDK's OpenTelemetry providers: spans and log records made with them get the session and view attributes and the same export |
| `replay.start()`, `replay.stop()`, `replay.capture()` | Start again after a stop, stop, or send a buffered replay from now on |
| `diagnostics()` | Counts for debugging: state, internal errors, drops by signal and reason, sent totals. Never a payload |

App-supplied event and attribute names starting with `session.` or `ouo.` are rejected, counted and never throw. The two exceptions are `ouo.exception.fingerprint` and `ouo.exception.handled` on `recordException`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | required | Collector OTLP/HTTP base URL. Must not contain credentials or a query |
| `headers` | none | Sent on every export. Never logged, never in a URL |
| `projectId`, `projectToken` | none | Builds the `Authorization: Basic` header |
| `serviceName` | required | `service.name` |
| `serviceVersion`, `environment` | none | `service.version`, `deployment.environment.name` |
| `enabled` | `true` | `false`: `init` touches nothing at all |
| `session.inactivityTimeoutMs` | 1 800 000 | At least 1 minute |
| `session.maxDurationMs` | 14 400 000 | At most 24 hours |
| `sampling.sessionRate` | `1` | Fraction of sessions that send telemetry |
| `sampling.bypass.perSessionCap` | `10` | Unhandled errors sent from a session that is not sampled |
| `replay.mode` | `structure/dom` | The replay technique. The web has one, and it is the only valid value: any other leaves replay off, with a warning |
| `replay.sessionRate` | `0` | Fraction of sampled sessions recorded from start to end |
| `replay.bufferRate` | `0` | Fraction of sampled sessions, besides those, that keep a ring in memory and send it after an unhandled error or `replay.capture()` |
| `replay.bufferSeconds` | `60` | What the buffer ring holds at least |
| `replay.chunkMaxBytes`, `replay.chunkMaxMs` | 262 144, 5000 | Chunk bounds. Hard limit 1 MiB |
| `replay.keyframeIntervalMs` | 300 000 | A new keyframe and segment at least this often |
| `consent.required` | `false` | Start with consent pending |
| `privacy.urlQueryAllow` | none | Query keys whose values are kept |
| `privacy.keepUrlFragment` | `false` | Keep the fragment (sanitised when query-shaped) |
| `sanitizeUrl` | none | Runs after the built-in URL sanitising |
| `beforeSend` | none | Last look at every log record and span |
| `propagation.urls` | none | Cross-origin URLs that get `traceparent` (exact string, prefix ending in `*`, or RegExp). Same origin always does |
| `propagation.sessionBaggage` | `false` | Also send `baggage: session.id=<id>` |
| `transport.flushIntervalMs` | 5000 | |
| `transport.maxBatchRecords`, `maxRequestBytes`, `maxQueueRecords` | 512, 1 MiB, 2048 | |
| `transport.shutdownDeadlineMs` | 2000 | |
| `transport.retry.initialMs`, `.maxMs` | 1000, 300 000 | |
| `transport.persist.enabled`, `.ttlHours`, `.maxBytes` | `true`, 72, 5 MiB | The IndexedDB outbox |
| `debug` | `false` | Diagnostics on the console |
| `diagnostics.selfDisableThreshold` | `20` | Internal errors after which the SDK turns itself off |
| `instrumentations.<signal>` | on | `errors`, `webVitals`, `clicks`, `frustration`, `navigation`, `documentLoad`, `navigationTiming`, `fetch`, `xhr`. Off by default: `resourceTiming`, `hashNavigation`, `vitalAttributionBody` |
| `otel.registerGlobalProviders` | `false` | Register the SDK's tracer and logger providers as the OpenTelemetry globals |
| `otel.ignoreUrls` | none | Requests that are not traced, besides the SDK's own exports |

## What it sends

Telemetry is OTLP/HTTP JSON, gzipped, to `{endpoint}/v1/logs` and `{endpoint}/v1/traces`, on instrumentation scope `ouo.rum` with schema URL `https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev`. Events are log records with an `EventName`. There are no span events and no client metrics.

Every record carries `session.id` (32 hex characters), `ouo.view.id` (a new id for every page load, soft navigation and back/forward-cache restore), the sanitised `browser.document.url.full`, `enduser.id` after `setUser`, `ouo.view.name` after `trackNavigation`, and the global attributes. None of these is on the resource. The resource holds `service.*`, `deployment.environment.name`, `telemetry.sdk.*`, `os.*` and `browser.*` (or `user_agent.original` where the browser has no brands).

| Signal | Type and name | Notes |
|---|---|---|
| Session start, end | events `session.start`, `session.end` | `ouo.session.sample_rate`; `session.previous_id` on `session.start` only; `ouo.session.end_reason` (`timeout`, `max_duration`, `manual`, `shutdown`, `consent`) |
| Page load, soft navigation | event `browser.navigation` | `url.full`, `browser.navigation.same_document`, `.hash_change`, `.type` (`push`, `replace`, `reload`, `traverse`) |
| Page load span | span `documentLoad` | Made after `load`, `fetchStart` to `loadEventEnd`, no children. Parented to `<meta name="traceparent">` when the page has one |
| Navigation timing | event `browser.navigation_timing` | The `PerformanceNavigationTiming` milestones |
| Resource timing | event `browser.resource_timing` | Off by default. At most 200 per view |
| Web vitals | event `browser.web_vital` | `ttfb`, `fcp`, `lcp`, `cls`, `inp`. Once per vital per page load, when final; `delta` equals `value`; INP carries `browser.web_vital.attribution.*` |
| Errors | event `exception`, severity ERROR | `exception.*`, `ouo.exception.source` (`error`, `unhandledrejection`, `manual`), `ouo.exception.handled`, `code.*`, `ouo.exception.debug_ids` |
| Click | event `browser.user_action.click` | `browser.page.x`, `.y`, `browser.tag_name`, `browser.css_selector`, `browser.mouse_event.button`, `ouo.viewport.*`. Never element text |
| Frustration | event `ouo.user_action.frustration` | `.type`: `rage` (4 or more clicks on one element within 1 s, with `.click_count`), `dead` (nothing happened for 2 s), `error` (an unhandled error within 2 s) |
| Fetch, XHR | span, kind CLIENT, named by method | Stable HTTP attributes. One trace per request. `ouo.span.abandoned=true` when the page closed first |
| Custom | whatever `recordEvent` is given | |
| Drops | event `ouo.sdk.dropped` | `ouo.sdk.drop.signal`, `.reason`, `.count`, at most once per flush interval |
| Self-disable | event `ouo.sdk.disabled` | Once, when the SDK turns itself off |
| Replay | events `ouo.replay.chunk`, `ouo.replay.ended` on scope `ouo.replay` | [Replay](#replay) |

`console.error` and failed resource loads are not reported as errors. A click never starts a trace.

## Sessions and sampling

- A session starts on user activity: pointer down, key down, wheel or touch scroll, a navigation in a visible page, or the page becoming visible. `init` in a visible page counts. Telemetry, timers and requests do not extend it, so a tab that only polls starts no session.
- It ends after 30 minutes without activity, at 4 hours, on `restartSession()`, when a different user is set, and on `shutdown()` in the last open tab. Reaching the maximum with the user present rolls to a new session at once.
- All same-origin tabs share one session through `localStorage` (key `ouo.session`). Each `session.start` and `session.end` is emitted by exactly one tab, under a Web Lock where the browser has one. Where `localStorage` is blocked the session lives in memory for the page. Cookies are never used.
- Sampling is decided once per session from the id (the first 8 hex characters against `sampling.sessionRate`; the next 8 against the replay rate), so every tab agrees. A session that is not sampled sends only unhandled errors, marked `ouo.sampling.bypass=true` and capped per session. With no valid session, an unhandled error goes out marked `ouo.session.expired=true` and everything else is dropped and counted.

## Privacy

- **Consent.** With `consent.required` nothing is sent, nothing is written to `localStorage` or IndexedDB, and replay does not start until `setConsent`. Telemetry and replay consent are separate. On withdrawal capture stops, what was stored and not sent is deleted, and a later grant starts a new session with no link to the old one.
- **URLs.** On every URL the SDK reports (page, requests, navigation, stack frames, replay): credentials become `REDACTED:REDACTED`, every query value becomes `REDACTED` unless its key is in `privacy.urlQueryAllow`, and the fragment is removed unless `privacy.keepUrlFragment`. A reasonable opt-in list for campaign analytics is `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`.
- **Users.** No user id is sent before `setUser`. There is no device or install id. No request or response bodies or headers are captured.
- **Clicks.** Selectors are tag names, `nth-of-type` and ids only; an id with a run of six or more digits is left out. No class names, attribute values or text.
- **`beforeSend`** sees every log record and span before it is queued, stored or sent, and may change its attributes or body, or drop it by returning `null` or `false`. A hook that throws changes nothing. It never sees replay chunks.

## Replay

A replay is a series of `ouo.replay.chunk` log records, sent as OTLP/HTTP protobuf to `{endpoint}/v1/logs`, one chunk per request, on their own queue so a replay backlog never delays telemetry. The body of the record is the chunk's bytes. Each chunk carries `session.id`, `ouo.replay.id`, `ouo.replay.stream.id` (one stream per page lifetime), `ouo.replay.segment.index`, `ouo.replay.sequence`, `ouo.replay.keyframe`, `ouo.replay.start_time`, `.end_time`, `.format`, `.encoding`, `.sha256`, `.byte_size`, `.masked`, `.mode`, and `.trigger` in buffer mode. A stream ends with `ouo.replay.ended` (`end_state` `complete` or `partial`, `last_sequence`, `end_reason`).

Chunks are written to IndexedDB before their first send and removed when the Collector accepts them. A later page of the same origin sends what a closed page left behind and ends its stream as `partial`.

**Whether a session records** is decided by two rates, read against one number derived from the session id: with `sessionRate: 0.1, bufferRate: 0.5`, one session in ten is recorded whole, half of all sessions keep the last minute in memory and send it only after an unhandled error or `replay.capture()` (then go on recording), and the rest record nothing. Both rates default to 0, so replay is off until one is set.

**How it records** is `replay.mode`. The web SDK has one technique:

| `replay.mode` | `ouo.replay.format` | What a chunk holds |
|---|---|---|
| `structure/dom` | `rrweb/2` | A description of the DOM: a full snapshot, then what a MutationObserver and input listeners see, as one JSON rrweb event per line, gzipped |

Masking is done on the device before a byte is encoded: text nodes become `***`, form values become `***`, and images, video and canvas are recorded as empty boxes. The lazy chunk for it is about 55 KB gzip and loads only in a session that records.

The other ouo techniques (`structure/wireframe`, `pixel/frames`, `pixel/video`) belong to React Native. A pixel recorder for the web is under development and paused; its source is in `src/replay/pixel.ts`, outside the build.

Unmask with `data-ouo-unmask` on an element (its subtree is recorded as written); `data-ouo-mask` inside it masks again and always wins; `data-ouo-block` blocks an element entirely. Password, payment and one-time-code fields are always masked and cannot be unmasked. If masking fails for an event or a frame, it is dropped and counted, never sent.

## React

```tsx
import { OuoErrorBoundary, useOuoRoute, routeTemplate } from "@ouo11y/browser/react";

useOuoRoute(routeTemplate(matchRoutes(routes, useLocation()))); // names the view: ouo.view.name = "/products/:id"

<OuoErrorBoundary fallback={<p>Something went wrong</p>}>
  <App />
</OuoErrorBoundary>;
```

`OuoErrorBoundary` reports a render error as a handled `exception` with `ouo.react.component_stack`. React in development also rethrows the error to `window`, where it is reported once more as unhandled; a production build reports it once. The entry is a client module (`"use client"`).

## OpenTelemetry

The SDK uses the OpenTelemetry JS API and SDK: one logger provider and one tracer provider, the OTel fetch and XHR instrumentations, the OTLP serializers, and `web-vitals` and `rrweb` behind them. What it adds is what OpenTelemetry does not have yet: sessions, the view id, session sampling with a bypass set, consent, URL sanitising, delivery rules for page lifetimes, and replay.

- The tracer and logger providers are not registered globally unless `otel.registerGlobalProviders` is set. Use `getTracerProvider()` and `getLoggerProvider()`.
- The fetch and XHR instrumentations need a global context manager and propagator. The SDK registers its own only when the host has none; a host that registered OpenTelemetry first keeps what it registered, and then its propagator decides which headers are sent.
- An app-set `traceparent`, `tracestate` or `baggage` header is never overwritten.

## Delivery

- Batches every 5 s or at 512 records, gzipped. `429` and `503` are retried honouring `Retry-After`; `502`, `504` and network failures are retried with exponential backoff and full jitter; any other status is dropped and counted. A `2xx` with rejected records is not retried.
- When the queue is full the oldest ordinary records go first; unhandled errors go last.
- At page hide everything queued leaves with `fetch` `keepalive`, within 60 KiB in total, errors first, then telemetry, then a replay chunk if it fits. No `unload` or `beforeunload` handler is registered, so the back/forward cache keeps working.
- A batch the Collector could not take is copied to IndexedDB and sent by this or a later page (one tab at a time). Stored data expires after 72 hours and is capped at 5 MiB; replay is evicted before telemetry, telemetry before unhandled errors. On WebKit an IndexedDB write that starts while the page is closing does not commit, so a record made in the last moment before close while the Collector is down can be lost there.

## Compatibility and safety

- Browsers: Chrome and Edge 94, Firefox 93, Safari 16.4 and later (ES2022). CI checks the built files with `es-check` and imports them in Node.
- Initial JavaScript is about 49 KB gzip (`index.js` plus its shared chunk); replay loads only in sessions that record. Budgets are in `size-budget.json` and checked in CI.
- Tests: `npm test` (unit, wire against a fake Collector, and fault injection in every SDK internal), `npm run test:e2e` (Chromium, Firefox and WebKit: page lifecycle, tabs, IndexedDB, structure replay, a strict Content-Security-Policy with Trusted Types, and the same page journey with the SDK off and under every fault, compared). `_internal.injectFault(name)` is the test hook; it is not public API.
- Storage: `localStorage` keys start with `ouo.`; the IndexedDB database is `ouo-outbox`. The SDK never clears storage it does not own.

## Development

```bash
npm run build      # tsup: dist/index.js, lazy replay chunks, dist/react.js
npm test           # vitest
npm run test:e2e   # playwright, needs the build
npm run size:check && npm run compat:check
```

Tests run against the browser builds of the OTel packages (see `vitest.config.ts`).
