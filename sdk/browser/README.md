# @ouo11y/browser

OpenTelemetry-native Real User Monitoring for the browser: sessions, errors, fetch/XHR
tracing with W3C Trace Context and Baggage, Web Vitals, navigation events and rrweb session
replay. Everything goes to the OpenTelemetry Collector (`ouo-collector`, the only public
ingest): spans and log records as OTLP/HTTP (JSON) on `/v1/traces` and `/v1/logs`, replay
chunks on the collector's replay receiver `/v1/replay/chunks`, every request carrying HTTP
Basic project credentials (ADR-0007). rum-api is internal and never reached from the browser.

## Install

```bash
npm install @ouo11y/browser
```

ESM only, TypeScript types included. The main entry is about 42 KB gzipped; rrweb is a
separate chunk (about 77 KB gzipped) that is only downloaded when replay is enabled and the
session is sampled. Supported browsers and what the SDK guarantees about the host page:
"Compatibility and safety" below.

## Init

```ts
import { initRUM, type RUM } from "@ouo11y/browser";

const rum: RUM = initRUM({
  endpoint: "http://localhost:4318",            // collector OTLP/HTTP base: /v1/traces, /v1/logs
  // replayEndpoint: "http://localhost:4319",   // optional; this is the default when endpoint uses port 4318
  projectId: "demo",                            // Basic auth username
  projectToken: "pt_dev_demo_0000000000000000", // Basic auth password; public, ships in the bundle
  service: { name: "web-store", version: "1.4.2", environment: "local" },
  tracing: { propagateTo: [/^http:\/\/localhost:8081/] },
  replay: { enabled: true, maskAllInputs: true },
  debug: true,
});

rum.setUser({ id: "user-42" });
rum.captureError(new Error("payment declined"), { "cart.id": "c-1" });
rum.addEvent("cart.added", { sku: "sku-1", qty: 2 });
rum.setRoute("/products/:id");                  // app.screen.name; router integrations call it
rum.replay.pause(); rum.replay.resume(); rum.replay.isRecording();
rum.session.id(); rum.session.userId();
await rum.flush();
await rum.shutdown();                           // remove every hook; initRUM works again afterwards
```

Call `initRUM` once, as early as possible (before the app renders). A repeated call warns and
returns the running instance; after `rum.shutdown()` a new `initRUM` starts a new one. A missing or empty `projectId` or `projectToken` throws at init (nothing is
installed), so a misconfigured deployment fails loudly instead of posting telemetry that the
collector rejects with `401`. The token is public by design: it names the project, grants only
the right to write into it under the collector's limits, and is rotated in the collector's
htpasswd file, like every RUM vendor's key. Every request carries
`Authorization: Basic base64(projectId + ":" + projectToken)`; a stock OpenTelemetry SDK with
`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64>` reaches the same endpoint.

## Options

| Option | Default | Meaning |
|---|---|---|
| `endpoint` | required | Collector OTLP/HTTP base URL. OTLP goes to `${endpoint}/v1/traces` and `${endpoint}/v1/logs`. |
| `replayEndpoint` | derived | Replay receiver base; chunks go to `${replayEndpoint}/v1/replay/chunks`. Default: `endpoint` with port `4319` when `endpoint` uses port `4318`, otherwise `endpoint` itself (a proxy routing `/v1/replay/*`). |
| `projectId` | required | Project identifier, the Basic auth username. Throws when missing, empty or containing `:`. |
| `projectToken` | required | Public project token, the Basic auth password. Throws when missing or empty. |
| `service.name` / `service.version` / `service.environment` | required | Resource attributes `service.name`, `service.version`, `deployment.environment.name`. `service.version` is also put on every span and log record. |
| `tracing.propagateTo` | `[]` | URLs that receive `traceparent` and `baggage` on fetch/XHR: a RegExp, or a string that must equal the whole request URL (OpenTelemetry compares strings with `===`, so `"http://localhost:8081"` matches no API call; use `/^http:\/\/localhost:8081\//`). Same-origin requests always do. |
| `tracing.ignoreUrls` | `[]` | URLs never traced. The OTLP and replay endpoints are always ignored. |
| `tracing.documentLoad` | `true` | Emit a `documentLoad` span from Navigation Timing; a child of the server span when the page has `<meta name="traceparent">` (see "Linking the page load"). |
| `tracing.interactions` | `true` | A `click` span per click, parent of the requests and the soft navigation it causes (see "Interactions"). |
| `tracing.softNavigations` | `true` | A `soft-navigation` span per SPA route change, until the new route settles. |
| `tracing.idleTimeoutMs` | `1000` | Quiet period (no request, no DOM mutation) that ends a click or soft-navigation span. |
| `clicks.rageClicks` | `{ threshold: 3, windowMs: 1000, radiusPx: 30 }` | `ouo.rage_click` for that many clicks on one element or spot within `windowMs`; `false` turns it off. |
| `clicks.deadClicks` | `true` | `ouo.dead_click` for a button or link click after which nothing happened. |
| `longTasks` | `{ thresholdMs: 100, maxPerPage: 50 }` | `ouo.long_animation_frame` (Chromium 123+) or `ouo.long_task` (older Chromium) events; `false` turns them off. Firefox and Safari have neither API. |

| `replay.enabled` | `true` | When false rrweb is never downloaded. |
| `replay.maskAllInputs` | `true` | Mask every input value in the recording. |
| `replay.sampleRate` | `1` | Fraction of (sampled) sessions that get a full replay, decided once per session and persisted. |
| `replay.onErrorSampleRate` | `0` | Fraction of the other sessions that keep the last 30 to 60 s of replay in memory and upload it, and the rest of the session, after the first error (error-triggered replay). |
| `replay.flushIntervalMs` | `5000` | Upload a chunk at least this often. |
| `replay.maxChunkBytes` | `262144` | Upload a chunk when the buffer reaches this size. |
| `replay.blockSelector` | none | CSS selector of elements recorded as an empty box of the same size, in addition to the `ouo-block` class. The cheapest way to keep a big widget (a data grid, a map) out of the replay's cost. |
| `replay.maskTextSelector` | none | CSS selector of elements whose text is masked, in addition to the `ouo-mask` class. |
| `session.inactivityTimeoutMs` | `1800000` (30 min) | Session ends after this much inactivity. |
| `session.maxDurationMs` | `14400000` (4 h) | Session ends after this total duration. |
| `session.sampleRate` | `1` | Fraction of sessions that send anything (spans, events, replay), decided from the session id (see "Sampling") and persisted. Unsampled sessions send `traceparent` with the sampled flag off, so the backend drops its side too. |
| `user.id` | anonymous | Initial user id. Otherwise an anonymous id is generated and persisted (`ouo.user.anonymous=true`). |
| `debug` | `false` | Log SDK decisions to the console with the `[ouo]` prefix. |

## Sessions

Implements `docs/specs/session-lifecycle.md` for the web:

- State is persisted in `localStorage` under `ouo.session` (`{ id, startedAt, lastActivity, previousId, replaySeq, sampled, replaySampled, replayOnError, replayTriggered, endedAt, endReason }`) and `ouo.user`.
- Activity: click, keydown, scroll, touchstart, pointerdown, tab becoming visible, navigation, outbound fetch/XHR. Persisted at most once per second.
- Ends: `inactivity` (30 min) or `max_duration` (4 h), detected by a timer in the tab, on the next init, or lazily when the next signal needs a session. The session is not rotated immediately on inactivity: the next activity or signal starts the new one with `session.previous_id` set.
- Tabs of the same origin share the session through the `storage` event; a session ended in one tab is not ended again by another.
- Web uncaught errors do not end the session; they mark it crashed (ADR-0004).

## Identifiers on every signal

Every span and log record carries `session.id`, `user.id`, `ouo.user.anonymous`,
`ouo.platform=web`, `service.version` and, for sessions that replaced an expired one,
`session.previous_id`, and `app.screen.name` once a route is named with `rum.setRoute` (not on
the `navigation` event, which is written before the new route renders). Outbound requests to `tracing.propagateTo` origins carry
`traceparent` and `baggage: session.id=…,user.id=…,ouo.platform=web`.

## Events emitted (OTel log records, `event.name`)

| `event.name` | When | Attributes |
|---|---|---|
| `session.start` | new session | `ouo.session.started_at` (epoch ms) |
| `session.end` | session expired | `ouo.session.end_reason`, `ouo.session.duration_ms`, `ouo.session.started_at`, `ouo.session.ended_at` |
| `exception` | uncaught error, unhandled rejection (fatal), `captureError`, `console.error`, resource load failure, React error boundary (non-fatal) | `exception.type`, `exception.message`, `exception.stacktrace`, `ouo.exception.fatal`, `ouo.exception.handled`, `ouo.exception.kind` (`uncaught`, `unhandledrejection`, `captured`, `console`, `resource`, `react.error_boundary` with `ouo.react.component_stack`). A `console.error` of an object `captureError` reports in the same task is not reported twice. |
| `http.request.failed` | fetch/XHR with status 5xx or a network failure (status 0). 4xx is not an error. | `http.request.method`, `url.full`, `http.response.status_code` |
| `navigation` | page load and `pushState` / `replaceState` / `popstate` | `url.path`, `url.full`, `ouo.navigation.from`, `ouo.navigation.kind` (`load`, `push`, `replace`, `pop`) |
| `web_vital` | web-vitals callbacks (TTFB, FCP, LCP, CLS, INP); CLS and the final INP when the page is hidden or left | `ouo.web_vital.name`, `ouo.web_vital.value`, `ouo.web_vital.rating`, `ouo.web_vital.id`, `ouo.web_vital.delta`, `ouo.web_vital.navigation_type`, `url.path` |
| `ouo.rage_click` | 3 or more clicks on one element or spot within 1 s (one event per burst, at its first click) | `app.widget.id`, `app.widget.name`, `app.screen.coordinate.x` / `.y`, `url.path`, `ouo.click.count`, `ouo.click.duration_ms` |
| `ouo.dead_click` | a click on a button, link or `role=button` after which no request, DOM mutation or navigation happened before the interaction went idle. Form fields, labels, disabled buttons and links or submit buttons that leave the page never count. | `app.widget.id`, `app.widget.name`, `app.screen.coordinate.x` / `.y`, `url.path` |
| `ouo.long_animation_frame` | a Long Animation Frame of `longTasks.thresholdMs` or more (Chromium 123+) | `ouo.long_task.duration_ms`, `.blocking_duration_ms`, `.render_start_ms`, `.script_count`, and the longest script: `ouo.long_task.script.duration_ms`, `.invoker`, `.invoker_type`, `.char_position`, `code.file.path`, `code.function.name`; `url.path` |
| `ouo.long_task` | a Long Task, in Chromium without Long Animation Frames | `ouo.long_task.duration_ms`, `ouo.long_task.container_type`, `ouo.long_task.container_src`, `url.path` |
| `ouo.replay.skipped` | replay stopped for the page view because its full snapshot is larger than the 2 MB replay buffer (it could never be uploaded) | `ouo.replay.skip_reason` (`snapshot_too_large`), `ouo.replay.snapshot_bytes` |
| custom | `rum.addEvent(name, attrs)` | your attributes plus `ouo.event.custom=true` |

Spans: `documentLoad` (and its resource fetches), one `CLIENT` span per fetch/XHR
(`http.request.method`, `url.full`, `http.response.status_code`, `server.address`), `click` and
`soft-navigation` (below).

Attribute names: OpenTelemetry semantic conventions where they exist (`app.widget.*`,
`app.screen.*`, `code.*`, `url.*`, `http.*`, `session.*`), `ouo.*` otherwise. The browser and RUM
conventions are still in development (semconv has an incubating `browser.web_vital` event), so
`ouo.*` names may move to them later (checklist N26).

## Interactions

Browsers have no async context (no zone.js; TC39 AsyncContext is pending), so a `fetch` sent after
an `await` in a click handler would start a new trace. The SDK opens an "idle span" instead:

- `click` (`app.widget.id`, `app.widget.name`, `app.screen.coordinate.*`, `url.path`) starts at the
  click and is the parent of every span started from the root context while it is open: the
  requests the handler sends, after any number of awaits, and the `soft-navigation` it triggers.
- `soft-navigation` (`url.path`, `url.full`, `ouo.navigation.from`, `ouo.navigation.kind`,
  `app.screen.name`) starts at `pushState` / `replaceState` / `popstate` and parents the requests the
  new route sends. Its duration is the route change's time to settle.
- A span ends `tracing.idleTimeoutMs` (1 s) after its last activity (a child span starting or
  ending, a DOM mutation), at the time of that activity, or after 15 s, or when the page is hidden
  (`ouo.interaction.end_reason`: `idle`, `timeout`, `superseded`, `hidden`). A new click ends the
  previous click span.
- A click that caused no request or navigation is not exported (it would be a one-span trace); it is
  still a timeline event when it was dead or part of a rage burst.
- Heuristic limits: a request started by a timer or poll while an interaction is open is attributed to
  it; continuous DOM animation keeps a span open until the 15 s cap. An explicit
  `context.with(span, ...)` always wins over the fallback.

Element names never read input values, and never the text of elements inside `ouo-mask` or
`ouo-block`; text is only read from buttons and links (`aria-label` and `data-testid` win).

## Linking the page load (`<meta name="traceparent">`)

A server-rendered page can make the browser's `documentLoad` span a child of the server span that
rendered it: write the W3C `traceparent` of that span into the page head.

```html
<meta name="traceparent" content="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" />
```

With OpenTelemetry Go (`otelhttp`), in the handler that renders the page:

```go
sc := trace.SpanContextFromContext(r.Context())
meta := fmt.Sprintf("00-%s-%s-%s", sc.TraceID(), sc.SpanID(), sc.TraceFlags())
// <meta name="traceparent" content="{{ .TraceParent }}"> in the template
```

Node (`@opentelemetry/api`): `const c = trace.getActiveSpan()?.spanContext()` and
`` `00-${c.traceId}-${c.spanId}-0${c.traceFlags}` ``. Any language: inject the current context with
the W3C propagator into a map and print its `traceparent`. The page must not be cached with the
tag (each response has its own span). Then Tempo shows server span -> `documentLoad` ->
`documentFetch` / `resourceFetch` in one trace. Verified in Chromium, Firefox and WebKit
(`e2e/sdk.spec.ts`) and against the local stack. The session's sampling decision still applies: an
unsampled session records no `documentLoad`.

## Sampling (roadmap 8b)

Three decisions, each a function of the session id and kept in `ouo.session` (so reloads, other
tabs and a later rate change agree). The rule is shared with `@ouo11y/react-native` and rum-api's
per-project cap, so a server rate lower than the client's keeps a consistent subset:

```
sampled(id, rate, salt) = fmix32(fnv1a32(salt + ":" + id)) / 2^32 < rate
```

FNV-1a 32 over UTF-16 code units, then MurmurHash3's fmix32 finalizer (so one id's decisions under
different salts are independent); salts `session`, `replay`, `replay_on_error`. Test vectors:
`""` -> `0xab3e7c0b`, `"a"` -> `0x1a80b1b3` (`src/session/sampling.ts`, `test/sampling.test.ts`).

1. `session.sampleRate`: is the session sent at all? An unsampled session sends no span,
   event or replay, and its requests carry `traceparent` with the sampled flag `00`.
2. `replay.sampleRate`: of the sampled sessions, which get a full replay.
3. `replay.onErrorSampleRate`: of the rest, which record into memory (a full snapshot every 30 s,
   the last two kept, so 30 to 60 s) and upload that buffer, then everything after it, from the first
   `exception` of severity error (uncaught, unhandled rejection, `captureError`, `console.error`,
   error boundary; not resource errors). The switch is persisted (`replayTriggered`).

A per-project server-side override is not part of the SDK (roadmap 8b, collector or rum-api).

## Replay (ADR-0003)

- rrweb `record` with `maskAllInputs` (default true), `checkoutEveryNms` 5 min, no canvas or font collection.
- Privacy classes: add `ouo-block` to an element to exclude it from the recording (rendered as a placeholder), `ouo-mask` to replace its text with asterisks. Inputs are masked by default.
- Chunks: `{ session_id, seq, started_at, ended_at, events }` (timestamps are epoch milliseconds), flushed every 5 s or at 256 KB, gzip-compressed with `CompressionStream`, `POST ${replayEndpoint}/v1/replay/chunks` with headers `content-type: application/json`, `content-encoding: gzip`, `authorization: Basic ...`, `x-ouo-session-id`, `x-ouo-seq`. On `pagehide` the remaining buffer is sent uncompressed with `fetch(..., { keepalive: true })`, same headers.
- `seq` is stored with the session, so a reload continues the sequence; every page load starts with a full snapshot. A new session resets `seq` to 0 and takes a fresh full snapshot.
- Upload failures retry 3 times with backoff; pending data is capped at 2 MB (oldest chunks dropped).
- `rum.replay.pause()` stops recording and flushes; `resume()` starts a new recording with a full snapshot.
- Multi-tab: tabs of one origin share the session, and two recordings in one chunk sequence would interleave two DOMs. Only one tab records: the visible tab the user last focused, clicked or typed in. It claims a lease on the `BroadcastChannel` `ouo.replay` and starts with a full snapshot and an rrweb custom event `ouo.tab` (`tab_id`, `url`); the tab that loses the lease, or is hidden, stops and flushes. The replay is what the user looked at, one tab after the other. Without `BroadcastChannel` (Safari before 15.4) a tab only stops when hidden.
- The collector's replay receiver must answer CORS preflights allowing the headers above (`Authorization`, `Content-Type`, `Content-Encoding`, `X-Ouo-Session-Id`, `X-Ouo-Seq`) for your origin; the OTLP receiver needs `Authorization` and `Content-Type` (ADR-0007 section 4).

## Compatibility and safety

### Supported browsers

| | Supported (tested, every feature) | Runs (syntax floor, `es2022`) |
|---|---|---|
| Chrome, Edge | versions of the last 2 years (130+ in October 2026) | 94+ |
| Firefox | versions of the last 2 years (131+) | 93+ |
| Safari, iOS Safari (every iOS browser) | 18+ | 16.4+ |

The bundle is built for the syntax floor (`tsup.config.ts`) and CI checks every built file with
es-check (`npm run compat:check`): no syntax newer than ES2022 ships, so an app bundle that includes
the SDK still parses on those engines. Each optional platform feature is detected, and the SDK
does without it: Long Animation Frames / Long Tasks (`PerformanceObserver.supportedEntryTypes`,
Chromium only), `CompressionStream` (replay sent uncompressed), `BroadcastChannel` (each tab stops
recording only when hidden), `MutationObserver` (no DOM activity for interaction spans),
`crypto.randomUUID` (`getRandomValues`, then `Math.random`), `requestIdleCallback` (web-vitals falls
back to a timer). The SDK itself uses neither `scheduler` nor `requestIdleCallback`. Web Vitals per
engine: "Web Vitals in a real browser" below. Playwright runs every e2e spec in Chromium, Firefox
and WebKit on each PR.

### The host page is never broken

- **Every hook is guarded.** Event listeners, the patched `history.pushState` / `replaceState`,
  the patched `console.error`, fetch / XHR instrumentation hooks, `PerformanceObserver` and
  `MutationObserver` callbacks, web-vitals callbacks, timers and rrweb (`errorHandler` swallows its
  errors) catch their own exceptions: an SDK error never reaches `window.onerror`, an
  `unhandledrejection` handler or the caller of a patched function. With `debug: true` such an
  error is logged as `[ouo] contained`. `flush()` and `shutdown()` never reject, and the public
  methods never throw.
- **Patched functions behave like the originals.** They call the original first, with the same
  `this` and arguments, and return its result; what the original throws (a cross-origin
  `pushState` SecurityError) reaches the caller unchanged. Errors are observed with
  `addEventListener` only, never by assigning `window.onerror` / `onunhandledrejection`, so the
  page's own handlers, their return values and `preventDefault()` work as without the SDK.
  `shutdown()` restores a patched function only if it is still the SDK's: a router or tool that
  wrapped it later keeps its wrapper, and the SDK's layer becomes a pass-through.
- **Lifecycle.** A second `initRUM` warns and returns the running instance. `shutdown()` flushes,
  then removes every listener, observer, timer, instrumentation and OpenTelemetry global the SDK
  installed (an app that registered its own OpenTelemetry first keeps it), after which `initRUM`
  works again. If the SDK cannot start (a browser without something it needs), `initRUM` warns,
  removes what it had installed and returns an inert instance. Only a configuration error (a
  missing endpoint, id or token) throws.
- **Server rendering.** Both entries import in Node without `window` or `document`, and
  `initRUM` there returns an inert instance without registering one, so calling it at module
  scope of a client component is fine. `@ouo11y/browser/react` is a client module (`"use client"`):
  `OuoErrorBoundary` can wrap children in a Next.js App Router server layout. Checked with a Next.js
  15 production build and in Vitest (`test/ssr.test.ts`).
- **Strict CSP and Trusted Types.** The SDK and rrweb need no `unsafe-eval`, no `unsafe-inline` and
  no Trusted Types policy: `e2e/csp.spec.ts` runs a page under `script-src 'self'; style-src 'self';
  require-trusted-types-for 'script'; trusted-types 'none'` in the three engines with no violation,
  and events, traces and replay arrive. Add the collector's origins to `connect-src`.
- **Storage.** `localStorage` that throws on access (sandboxed or third-party iframes), is full
  (`QuotaExceededError`) or fails later falls back to memory for the rest of the page view, with
  the `ouo.*` keys it could still read: the session then lasts as long as the page.
- **Verified** by `e2e/faults.spec.ts` in Chromium, Firefox and WebKit: a page whose own listeners,
  fetch and XHR callbacks, timers and promises throw records the same transcript (what its own
  handlers saw, in order) with and without the SDK, with a healthy collector, blocked storage, full
  storage and a collector that is down.

### Long sessions and replay cost

- A 1 hour soak (`e2e/soak.spec.ts`: a busy single-page app with replay on, a route change every
  2 s, a ticker mutating 50 cells 4 times a second, requests and errors) shows no growth after the
  warm-up in listeners, observers, timers, DOM nodes or (Chromium) heap. Run it with
  `OUO_SOAK_MINUTES=60 npm run -w sdk/browser test:soak` or the `browser-soak` workflow.
- rrweb's cost grows with the DOM (`e2e/rrweb-cost.spec.ts`, Chromium, 10,000 elements): the
  initial full snapshot is one task of about 40 to 50 ms and about 1 MB of JSON before gzip;
  recording 10,000 text mutations a second costs about 6 % of the main thread and 1 MB of replay a
  second; the heap holds about 8 MB more than without replay. A full snapshot above the 2 MB replay
  buffer (in the order of 20,000 elements, depending on attributes and text) could never be
  uploaded, so the SDK stops replay for that page view and emits `ouo.replay.skipped`.
- Options, cheapest first: `replay.blockSelector` (or the `ouo-block` class) on the biggest widget:
  a blocked 10,000-cell table costs nothing to record (1 KB snapshot); `replay.sampleRate` below 1;
  `replay.onErrorSampleRate` with `sampleRate: 0` to record only sessions with an error (the buffer
  still pays the recording cost, not the upload); `rum.replay.pause()` around a heavy view.

## Debugging

With `debug: true` the SDK logs one init line with the URLs it derived and the project id, never the token:

```
[ouo] @ouo11y/browser@0.2.0 initialised { endpoint: "http://localhost:4318", replayEndpoint: "http://localhost:4319", traces: "http://localhost:4318/v1/traces", logs: "http://localhost:4318/v1/logs", replay: "http://localhost:4319/v1/replay/chunks", projectId: "demo", session: "...", user: "..." }
```

Common collector answers: `401` wrong or missing credential (basicauth), `429` or `503` rate limited (`ouoratelimit`, retried by the exporters), `413` payload too large, a CORS error with no POST at all when the page origin is not in the collector's `allowed_origins` or `Authorization` is missing from its allowed headers. Exporter responses are visible with the OTel diag logger (`debug: true` wires it to `console.warn`).

## React (`@ouo11y/browser/react`)

A separate entry so the core stays framework-free; React (16.8+) is an optional peer dependency.

```tsx
import { OuoErrorBoundary, routeTemplate, useOuoRoute } from "@ouo11y/browser/react";
import { matchRoutes, useLocation, useRoutes } from "react-router-dom";

function App() {
  useOuoRoute(routeTemplate(matchRoutes(routes, useLocation()))); // "/products/:id" -> app.screen.name
  return (
    <OuoErrorBoundary fallback={({ error, reset }) => <Failed error={error} onRetry={reset} />}>
      {useRoutes(routes)}
    </OuoErrorBoundary>
  );
}
```

- `OuoErrorBoundary` reports render errors of its subtree as `exception` (`ouo.exception.kind`
  `react.error_boundary`, handled, `ouo.react.component_stack`) and renders `fallback` (a node or a
  function of `{ error, reset }`); `attributes` and `onError` are optional. React's development build
  also rethrows the error to `window`, reported once more as uncaught; production builds report it once.
- `useOuoRoute(template)` calls `rum.setRoute`. `routeTemplate(matches)` joins React Router
  `matchRoutes` output (or any `[{ route: { path } }]`) into one template. Any other router: call
  `useOuoRoute` with the matched pattern.

## Web Vitals in a real browser

FCP, LCP, CLS and INP are only reported for a page that was visible from the start:
web-vitals drops them for a tab loaded in the background, and the Claude Browser pane and the
Chrome extension load their tabs hidden (only TTFB arrives there; `debug: true` logs "page loaded
hidden"). CLS and INP are final only when the page is hidden or left, so they ride on the flush at
`pagehide` / `visibilitychange` with `keepalive`. Two SDK fixes make that flush reliable:
its own batch processors instead of OTel's (which skip a flush while an export is in flight, so what
was emitted at hide after Chromium's `pagehide` flush never left), and INP followed with
`reportAllChanges` and emitted from the SDK's hide handlers (web-vitals' own final INP report runs
before its pending interaction entries are processed). Engine support: Chromium all five;
Firefox TTFB, FCP, LCP, INP (no Layout Instability API, so no CLS); WebKit (Playwright 27) TTFB,
FCP, LCP, INP.

## Development

```bash
npm run -w sdk/browser build      # tsup -> dist/index.js (+ rrweb chunk, .d.ts)
npm run -w sdk/browser test       # vitest + jsdom (includes a real-socket check against collector stubs on 127.0.0.1:18081 and :18082)
npm run -w sdk/browser size       # gzip sizes
npm run -w sdk/browser size:check # fails above sdk/browser/size-budget.json (CI)
npm run -w sdk/browser compat:check # es-check (no syntax above ES2022) + both entries import in Node (CI)
npm run -w sdk/browser test:e2e   # Playwright: Chromium, Firefox, WebKit against e2e/server.mjs (build first)
npm run -w sdk/browser test:soak  # soak (OUO_SOAK_MINUTES, default 2) + rrweb cost; OUO_SOAK_PROJECTS=chromium,webkit
node sdk/browser/playground/server.mjs   # static playground on :4173 + collector stub on :8090 (OTLP + replay on one port, Basic-auth checked)
```

Tests run against the browser builds of the OTel packages (see `vitest.config.ts`).
