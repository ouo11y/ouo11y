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

ESM only, TypeScript types included. The main entry is about 41 KB gzipped. Two chunks load
lazily: Web Vitals with INP attribution (about 6 KB, at `initRUM`), and rrweb (about 55 KB),
only downloaded when replay is enabled and the session is sampled. Supported browsers and what
the SDK guarantees about the host page: "Compatibility and safety" below.

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

rum.setUser({ id: "user-42" });                 // login keeps the session; another identified user rotates it
rum.clearUser();                                // logout: fresh anonymous id, new session
rum.endSession();                               // session.end (manual); the next activity starts a new one
rum.captureError(new Error("payment declined"), { "cart.id": "c-1" });
rum.addEvent("cart.added", { sku: "sku-1", qty: 2 });
rum.setRoute("/products/:id");                  // app.screen.name; router integrations call it
rum.replay.pause(); rum.replay.resume(); rum.replay.isRecording();
rum.session.id(); rum.session.userId(); rum.session.deviceId();
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
| `endpoint` | required | Collector OTLP/HTTP base URL. OTLP goes to `${endpoint}/v1/traces` and `${endpoint}/v1/logs`. A relative path (`/otel`) is a route on the page's own origin (see "First-party endpoint"). |
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
| `replay.maskAllInputs` | `true` | Mask the value of every form control (radios, checkboxes, hidden inputs, options and buttons too) and leave out checked / selected state. |
| `replay.sampleRate` | `1` | Fraction of (sampled) sessions that get a full replay, decided once per session and persisted. |
| `replay.onErrorSampleRate` | `0` | Fraction of the other sessions that keep the last 30 to 60 s of replay in memory and upload it, and the rest of the session, after the first error (error-triggered replay). |
| `replay.flushIntervalMs` | `5000` | Upload a chunk at least this often. |
| `replay.maxChunkBytes` | `262144` | Upload a chunk when the buffer reaches this size. |
| `replay.blockSelector` | none | CSS selector of elements recorded as an empty box of the same size, in addition to the `ouo-block` class. The cheapest way to keep a big widget (a data grid, a map) out of the replay's cost. |
| `replay.maskTextSelector` | none | CSS selector of elements whose text is masked, in addition to the `ouo-mask` class; it masks inside `ouo-unmask` too. |
| `replay.maskAllText` | `true` (since 0.4.0) | Mask every text node and the text attributes (`title`, `alt`, `placeholder`, `aria-label`, `aria-description`, `aria-valuetext`, `label`, `value` outside form controls) except inside `ouo-unmask` / `unmaskTextSelector`. Click names follow it. `false` restores the 0.3 behaviour (text recorded unless `ouo-mask`). See "Replay privacy". |
| `replay.unmaskTextSelector` | none | CSS selector of elements whose text is recorded with `maskAllText`, in addition to the `ouo-unmask` class. |
| `replay.excludeRoutes` | none | Never-record routes: paths (`/patients`), prefixes (`/patients/*`) or RegExps, matched against `location.pathname`. Nothing is recorded while one matches; also put `ouo-block` on the page's root. See "Replay privacy". |
| `session.inactivityTimeoutMs` | `1800000` (30 min) | Session ends after this much inactivity. |
| `session.maxDurationMs` | `14400000` (4 h) | Session ends after this total duration. |
| `session.sampleRate` | `1` | Fraction of sessions that send anything (spans, events, replay), decided from the session id (see "Sampling") and persisted. Unsampled sessions send `traceparent` with the sampled flag off, so the backend drops its side too. |
| `user.id` | anonymous | Initial user id. Otherwise an anonymous id is generated and persisted (`ouo.user.anonymous=true`). A different identified id than the resumed session's rotates the session (`user_change`). |
| `transport.compression` | `true` | gzip request bodies of 1 KB or more with `CompressionStream` (`Content-Encoding: gzip`); uncompressed where the browser lacks it. |
| `transport.maxAttempts` | `5` | Attempts per request, the first included, on network errors, timeouts, 408, 429 and 5xx before the request goes to the offline store. Other 4xx answers are never retried. |
| `transport.offline` | `{ maxBytes: 5242880, maxAgeMs: 86400000 }` | Keep unsent requests (IndexedDB, memory where storage is unavailable), at most `maxBytes` (oldest evicted first) and `maxAgeMs` old, and send them when back online or on the next page load. `false` drops them instead. |
| `transport.beacon` | `false` | At page hide, use `navigator.sendBeacon` when the keepalive budget is spent. A beacon cannot carry `Authorization`: only for a first-party route whose proxy adds it. |
| `debug` | `false` | Log SDK decisions to the console with the `[ouo]` prefix. |

## Sessions

Implements `docs/specs/session-lifecycle.md` for the web:

- State is persisted in `localStorage` under `ouo.session` (`{ id, startedAt, lastActivity, previousId, replaySeq, sampled, replaySampled, replayOnError, replayTriggered, endedAt, endReason }`), `ouo.user` (`{ id, anonymous }`) and `ouo.device` (`{ id }`). Where storage is blocked or full all three live in memory for the page (see "Compatibility and safety").
- Start: `initRUM` resumes the persisted session when it is younger than 4 h and active in the last 30 min (no `session.start`), otherwise it emits `session.end` for the expired one and starts a new one with `session.previous_id`.
- Activity: click, keydown, scroll, touchstart, pointerdown, tab becoming visible, navigation, outbound fetch/XHR. Persisted at most once per second.
- Ends (`ouo.session.end_reason`):

  | Reason | When | Next session |
  |---|---|---|
  | `inactivity` | no activity for `session.inactivityTimeoutMs` (30 min): a timer in the tab, the next init, or the next signal | starts with the next activity or signal |
  | `max_duration` | older than `session.maxDurationMs` (4 h) | same |
  | `user_change` | `setUser` with an identified id different from the current identified user, `clearUser()` (logout), or `user.id` in the options different from the resumed session's identified user | starts at once; `session.end` carries the previous `user.id`, the new session the new one |
  | `manual` | `rum.endSession()` | starts with the next activity or signal |

  Anonymous to identified (`setUser` after a login, the anonymous id was never a person) does not rotate: the session continues with the new `user.id`. Every new session after an end has `session.previous_id`.
- Device: `device.id` (OpenTelemetry semantic conventions) is random, generated once per browser profile and origin and persisted apart from the session and the user, so it survives rotation, login and logout and links the sessions of one browser. It is a resource attribute of every export and is on `session.start` / `session.end`; rum-api returns it as `device_id`. Nothing else (no IP address, no fingerprint) is used to link devices.
- Tabs of the same origin share the session through the `storage` event; a session ended in one tab is not ended again by another.
- Web uncaught errors do not end the session; they mark it crashed (ADR-0004).

## Identifiers on every signal

Every span and log record carries `session.id`, `user.id`, `ouo.user.anonymous`,
`ouo.platform=web`, `service.version` and, for sessions that replaced an expired one,
`session.previous_id`, and `app.screen.name` once a route is named with `rum.setRoute` (not on
the `navigation` event, which is written before the new route renders). Outbound requests to `tracing.propagateTo` origins carry
`traceparent` and `baggage: session.id=…,user.id=…,ouo.platform=web`. `device.id` is a resource
attribute (once per export, not per record).

## Events emitted (OTel log records, `event.name`)

| `event.name` | When | Attributes |
|---|---|---|
| `session.start` | new session | `ouo.session.started_at` (epoch ms), `device.id` |
| `session.end` | session expired, user changed or `endSession()` | `ouo.session.end_reason` (`inactivity`, `max_duration`, `user_change`, `manual`), `ouo.session.duration_ms`, `ouo.session.started_at`, `ouo.session.ended_at`, `device.id` |
| `exception` | uncaught error, unhandled rejection (fatal), `captureError`, `console.error`, resource load failure, React error boundary (non-fatal) | `exception.type`, `exception.message`, `exception.stacktrace`, `ouo.exception.fatal`, `ouo.exception.handled`, `ouo.exception.kind` (`uncaught`, `unhandledrejection`, `captured`, `console`, `resource`, `react.error_boundary` with `ouo.react.component_stack`). A `console.error` of an object `captureError` reports in the same task is not reported twice. |
| `http.request.failed` | fetch/XHR with status 5xx or a network failure (status 0). 4xx is not an error. | `http.request.method`, `url.full`, `http.response.status_code` |
| `navigation` | page load and `pushState` / `replaceState` / `popstate` | `url.path`, `url.full`, `ouo.navigation.from`, `ouo.navigation.kind` (`load`, `push`, `replace`, `pop`) |
| `web_vital` | web-vitals callbacks (TTFB, FCP, LCP, CLS, INP); CLS and the final INP when the page is hidden or left | `ouo.web_vital.name`, `ouo.web_vital.value`, `ouo.web_vital.rating`, `ouo.web_vital.id`, `ouo.web_vital.delta`, `ouo.web_vital.navigation_type`, `url.path`; INP adds its attribution: `ouo.web_vital.inp.target` (the element as `app.widget.id`, no text), `.interaction_type`, `.input_delay_ms`, `.processing_duration_ms`, `.presentation_delay_ms`, `.load_state`, and the longest Long Animation Frame script (`.script.invoker`, `.script.invoker_type`, `.script.subpart`, `.script.duration_ms`, `code.file.path`, `code.function.name`), [docs/specs/web-vitals.md](../../docs/specs/web-vitals.md) |
| `ouo.rage_click` | 3 or more clicks on one element or spot within 1 s (one event per burst, at its first click) | `app.widget.id`, `app.widget.name`, `app.screen.coordinate.x` / `.y`, `url.path`, `ouo.click.count`, `ouo.click.duration_ms` |
| `ouo.dead_click` | a click on a button, link or `role=button` after which no request, DOM mutation or navigation happened before the interaction went idle. Form fields, labels, disabled buttons and links or submit buttons that leave the page never count. | `app.widget.id`, `app.widget.name`, `app.screen.coordinate.x` / `.y`, `url.path` |
| `ouo.long_animation_frame` | a Long Animation Frame of `longTasks.thresholdMs` or more (Chromium 123+) | `ouo.long_task.duration_ms`, `.blocking_duration_ms`, `.render_start_ms`, `.script_count`, and the longest script: `ouo.long_task.script.duration_ms`, `.invoker`, `.invoker_type`, `.char_position`, `code.file.path`, `code.function.name`; `url.path` |
| `ouo.long_task` | a Long Task, in Chromium without Long Animation Frames | `ouo.long_task.duration_ms`, `ouo.long_task.container_type`, `ouo.long_task.container_src`, `url.path` |
| `ouo.replay.skipped` | replay stopped for the page view because its full snapshot is larger than the 2 MB replay buffer (it could never be uploaded) | `ouo.replay.skip_reason` (`snapshot_too_large`), `ouo.replay.snapshot_bytes` |
| `ouo.replay.hidden` | a recording session entered a never-record route (`replay.excludeRoutes`); once per hidden stretch and session | `ouo.replay.hidden_reason` (`route`) |
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

Element names (`app.widget.name`) follow the replay's text masking, whether or not replay is on:
with `replay.maskAllText` (the default) a click outside `ouo-unmask` / `unmaskTextSelector`, or
inside `ouo-mask`, `maskTextSelector` or `ouo-block`, is named by its `data-testid` only (no
text, `aria-label`, `title` or `name`); add `data-testid` to the buttons you want named in
telemetry. Where text may be read, `aria-label` and `data-testid` win, then the text of a button
or link, then `title` or `name`. Input values are never read. `app.widget.id` (tag, id, two
classes, `data-testid`) is structural and always set.

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

- rrweb `record` with `maskAllInputs` (default true), `checkoutEveryNms` 5 min (30 s while buffering), no canvas or font collection. The bundled rrweb is patched at build time so a blocked iframe's document is neither recorded nor observed (`tsup.config.ts`): rrweb 2.1.7 did both, and on Safari, where rrweb keeps two hidden helper iframes, every checkout added observers that were never released.
- Privacy: all text and every input are masked by default; see "Replay privacy" below.
- Chunks: `{ session_id, seq, started_at, ended_at, events }` (timestamps are epoch milliseconds), flushed every 5 s or at 256 KB, `POST ${replayEndpoint}/v1/replay/chunks` with headers `content-type: application/json`, `content-encoding: gzip` (bodies of 1 KB or more), `authorization: Basic ...`, `x-ouo-session-id`, `x-ouo-seq`. Chunks go through the same delivery layer as OTLP (see "Delivery"): on `pagehide` the remaining buffer leaves uncompressed with `keepalive`, and what does not fit the keepalive budget is kept for the next page load.
- `seq` is stored with the session, so a reload continues the sequence; every page load starts with a full snapshot. A new session resets `seq` to 0 and takes a fresh full snapshot.
- Failed uploads are retried, then kept offline, by the delivery layer; a chunk the receiver refuses (4xx) is dropped and counted. Pending data in memory is capped at 2 MB (oldest chunks dropped).
- `rum.replay.pause()` stops recording and flushes; `resume()` starts a new recording with a full snapshot.
- Multi-tab: tabs of one origin share the session, and two recordings in one chunk sequence would interleave two DOMs. Only one tab records: the visible tab the user last focused, clicked or typed in. It claims a lease on the `BroadcastChannel` `ouo.replay` and starts with a full snapshot and an rrweb custom event `ouo.tab` (`tab_id`, `url`); the tab that loses the lease, or is hidden, stops and flushes. The replay is what the user looked at, one tab after the other. Without `BroadcastChannel` (Safari before 15.4) a tab only stops when hidden.
- The collector's replay receiver must answer CORS preflights allowing the headers above (`Authorization`, `Content-Type`, `Content-Encoding`, `X-Ouo-Session-Id`, `X-Ouo-Seq`) for your origin; the OTLP receiver needs `Authorization` and `Content-Type` (ADR-0007 section 4).

### Replay privacy (ADR-0003, revision 2026-11-03)

Masked by default, since 0.4.0 (a breaking change: 0.3 recorded text unless it was in `ouo-mask`):

| What | Default | Opt out / in |
|---|---|---|
| Form controls: the value of every input (radios, checkboxes, hidden inputs too), `<select>`, `<option>`, `<button>`; the checked / selected state of radios, checkboxes and options | values masked (`*`), state left out (a radio shows unchecked), `ouo-unmask` included | `replay.maskAllInputs: false` (rrweb's own rules then: passwords stay masked) |
| Text nodes, and the attributes `title`, `alt`, `placeholder`, `aria-label`, `aria-description`, `aria-valuetext`, `label`, `value` (on other elements: `<li>`, `<data>`, `<meter>`) | masked: every non-space character becomes `*`, so the layout keeps its shape | `ouo-unmask` class or `replay.unmaskTextSelector` on an element: its subtree is recorded as written. `replay.maskAllText: false` turns the default off |
| `ouo-mask` / `replay.maskTextSelector` | masks its subtree | wins inside an unmasked area, and an `ouo-unmask` inside it stays masked |
| `ouo-block` / `replay.blockSelector` | the element is an empty box of the same size, nothing inside is recorded | wins over everything |
| Click names (`app.widget.name`) | follow the text rule above | `data-testid` is always used |
| Never-record routes | none | `replay.excludeRoutes` |

```html
<header class="ouo-unmask">Appointments · Settings</header>   <!-- recorded as written -->
<main>Jane Doe, born 1970</main>                               <!-- **** **** **** **** -->
<div class="ouo-unmask"><span class="ouo-mask">Room 4</span></div> <!-- still masked -->
```

Text in a shadow root is masked even under an `ouo-unmask` host (`closest()` does not cross the
boundary): put `ouo-unmask` inside the shadow tree. A `<title>` in `<head>` is a text node too.
The URL in the `ouo.tab` marker and in `url.full` is not masked; keep personal data out of URLs.
Other attributes are recorded as written: `class`, `id`, `href`, `src`, `style` and `data-*`
(styling depends on them); keep personal data out of them, or `ouo-block` the element.

**Never-record routes.** `excludeRoutes: ["/patients/*", "/identity", /^\/sign\//]`. A string
matches `location.pathname` exactly, or as a prefix when it ends with `*` (like a funnel `page:`
step); a RegExp is tested. Only the path: a template given to `rum.setRoute()` arrives after the
page rendered, too late to keep it out. The SDK checks on page load, on every `pushState` /
`replaceState` / `popstate` it already tracks, and for every event rrweb hands over, so a render
that reaches rrweb before the SDK hears of the navigation (a router's `popstate` listener
registered before `initRUM`, a router holding the unpatched `pushState`) is dropped too. Entering such a route writes an rrweb custom
event `ouo.replay.hidden` (`{ reason: "route" }`) and an `ouo.replay.hidden` event on the timeline
(`ouo.replay.hidden_reason: route`), then stops recording and flushes; nothing of the page is
recorded until the route is left. Recording restarts 500 ms after leaving, with a full
snapshot: routers such as React Router change the URL first and render the next page after it,
and a snapshot taken at once would hold the never-record page. A page
loaded on an excluded route records nothing from the start.

Limits, and the hard guarantee: a router that renders the new page in one task and changes the
URL in a later one records that render; leaving a route, a page kept on screen longer than 500 ms
(a React transition, a Suspense lazy route) can be in the next snapshot; a page whose path
carries no route (a modal over the same URL) is not matched; hash routers (`/#/patients`) are
not matched (the SDK reads `pathname`). **Put `ouo-block` on the root element of every
never-record page as well**: every timing gap then records an empty box, nothing of the page.
For a page without its own path, call `rum.replay.pause()` before showing it and `resume()`
after.

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
Chromium only), `CompressionStream` (OTLP and replay bodies sent uncompressed), `BroadcastChannel` (each tab stops
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

## Delivery

Every ingest request (OTLP traces and logs, replay chunks) goes through one delivery layer (`src/transport/`) so a flaky network, a busy collector or a closed tab loses as little as possible:

| Situation | What the SDK does |
|---|---|
| Page visible | gzip the body (1 KB or more), `POST` with `keepalive` while the 64 KB keepalive budget allows, abort after 30 s. |
| Network error, timeout, `408`, `429`, `5xx` | Retry with exponential backoff and jitter (1 s, 2 s, 4 s, ... capped at 30 s), or after `Retry-After` when the answer has one, up to `transport.maxAttempts`. A `Retry-After` over 60 s, or the last failed attempt, sends the request to the offline store. |
| Any other `4xx` | Dropped at once (the request is wrong; retrying cannot help) and counted. |
| `navigator.onLine` is false | Straight to the offline store; sent on the `online` event. |
| Page hidden or closing (`visibilitychange` to hidden, `pagehide`) | The request leaves synchronously, uncompressed, with `fetch(..., { keepalive: true })`. A batch larger than what is left of the 64 KB budget is split until each part fits; what still does not fit goes to the offline store (and is also sent plainly, in case the tab only went to the background), or by `navigator.sendBeacon` with `transport.beacon`. A retry waiting for its backoff is sent at once on this path. |
| Offline store | IndexedDB database `ouo-delivery` (per origin, shared by tabs), memory when IndexedDB is missing, blocked or fails (private mode, sandboxed iframe); a full disk keeps the entry in memory. Hard cap `transport.offline.maxBytes` (default 5 MB) with oldest-first eviction, entries older than `maxAgeMs` (24 h) dropped. Sent oldest first on `online`, when the page is shown again, after any successful request, and on the next page load of the origin, by one tab at a time (Web Locks). Nothing here throws into the page. |

Delivery is at least once: a request kept at page hide whose plain request also arrived is sent again by the next page load. Tempo, Loki and the replay receiver absorb the duplicate (same span id, same log line, same chunk `seq`).

`rum.deliveryStats()` returns the counters since `initRUM`: `sent`, `retried`, `queued` (kept offline), `dropped` and `droppedBytes` with `dropReasons` (`rejected`, `store_full`, `too_large`, `expired`, `no_store`, `queue_full`), and `rawBytes` / `wireBytes` for the bytes before and after gzip. With `debug: true` every drop is logged with `console.warn`, and every request with its size and the gzip saving. OTLP JSON compresses about 10 to 20 times (a 13.5 KB batch of 50 log records is 0.6 KB gzip; a 6.8 KB rrweb chunk is 0.3 KB).

The collector accepts `Content-Encoding: gzip` on the OTLP receiver and the replay receiver, and its CORS config allows the header and exposes `Retry-After` (`deploy/compose/collector/config.yaml`).

## First-party endpoint (ad blockers)

Blocklists match third-party telemetry hosts and paths, so some users never reach the collector. Serve the collector under your own origin and give the SDK a relative endpoint:

```ts
initRUM({ endpoint: "/otel", projectId, projectToken, service });
// traces -> /otel/v1/traces, logs -> /otel/v1/logs, replay -> /otel/v1/replay/chunks
```

The reverse proxy sends `/otel/v1/replay/*` to the replay receiver (port 4319) and the rest of `/otel/*` to the OTLP receiver (port 4318), strips `/otel`, and keeps the body and its `Content-Encoding` untouched. Same origin means no CORS preflight. nginx, Caddy and Next.js examples are in [docs/first-party-endpoint.md](https://github.com/ouo11y/ouo11y/blob/main/docs/first-party-endpoint.md); `examples/ouo-web/scripts/run.sh --first-party` runs the storefront journey that way.

## Debugging

With `debug: true` the SDK logs one init line with the URLs it derived and the project id, never the token:

```
[ouo] @ouo11y/browser@0.2.0 initialised { endpoint: "http://localhost:4318", replayEndpoint: "http://localhost:4319", traces: "http://localhost:4318/v1/traces", logs: "http://localhost:4318/v1/logs", replay: "http://localhost:4319/v1/replay/chunks", projectId: "demo", session: "...", user: "..." }
```

Common collector answers: `401` wrong or missing credential (basicauth, dropped), `429` or `503` rate limited (`ouoratelimit`, retried after `Retry-After`), `413` payload too large (dropped), a CORS error with no POST at all when the page origin is not in the collector's `allowed_origins` or `Authorization` is missing from its allowed headers. With `debug: true` the delivery layer logs every request, retry and drop (`[ouo] logs: HTTP 503, retry 1 in 812 ms`, `[ouo] delivery: dropped 2048 B (rejected): traces: HTTP 400`).

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
npm run -w sdk/browser compat:check # es-check (no syntax above ES2022), entries import in Node, source maps map the minified code (CI)
npm run -w sdk/browser test:e2e   # Playwright: Chromium, Firefox, WebKit against e2e/server.mjs (build first)
                                  # e2e/delivery.spec.ts injects network faults; OUO_E2E_PAGE_PORT=4280 moves the servers (collector stub on the next port)
npm run -w sdk/browser test:soak  # soak (OUO_SOAK_MINUTES, default 2) + rrweb cost; OUO_SOAK_PROJECTS=chromium,webkit
node sdk/browser/playground/server.mjs   # static playground on :4173 + collector stub on :8090 (OTLP + replay on one port, Basic-auth checked)
```

Tests run against the browser builds of the OTel packages (see `vitest.config.ts`).
