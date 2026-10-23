# @ouo11y/browser

OpenTelemetry-native Real User Monitoring for the browser: sessions, errors, fetch/XHR
tracing with W3C Trace Context and Baggage, Web Vitals, navigation events and rrweb session
replay. Everything goes to the OpenTelemetry Collector (`ouo-collector`, the only public
ingest): spans and log records as OTLP/HTTP (JSON) on `/v1/traces` and `/v1/logs`, replay
chunks on the collector's replay receiver `/v1/replay/chunks`, every request carrying HTTP
Basic project credentials (ADR-0007). rum-api is internal and never reached from the browser.

## Install

```bash
# .npmrc in the app, once (private until stable: docs/releasing.md, section 7)
@ouo11y:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```bash
npm install @ouo11y/browser
```

ESM only, TypeScript types included. The main entry is about 40 KB gzipped; rrweb is a
separate chunk (about 82 KB gzipped) that is only downloaded when replay is enabled and the
session is sampled.

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
rum.replay.pause(); rum.replay.resume(); rum.replay.isRecording();
rum.session.id(); rum.session.userId();
await rum.flush();
```

Call `initRUM` once, as early as possible (before the app renders). Repeated calls return
the same instance. A missing or empty `projectId` or `projectToken` throws at init (nothing is
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
| `tracing.propagateTo` | `[]` | Origins (RegExp or exact string) that receive `traceparent` and `baggage` on fetch/XHR. Same-origin requests always do. |
| `tracing.ignoreUrls` | `[]` | URLs never traced. The OTLP and replay endpoints are always ignored. |
| `tracing.documentLoad` | `true` | Emit a `documentLoad` span from Navigation Timing. |
| `replay.enabled` | `true` | When false rrweb is never downloaded. |
| `replay.maskAllInputs` | `true` | Mask every input value in the recording. |
| `replay.sampleRate` | `1` | Fraction of sessions that get a replay, decided once per session and persisted. |
| `replay.flushIntervalMs` | `5000` | Upload a chunk at least this often. |
| `replay.maxChunkBytes` | `262144` | Upload a chunk when the buffer reaches this size. |
| `session.inactivityTimeoutMs` | `1800000` (30 min) | Session ends after this much inactivity. |
| `session.maxDurationMs` | `14400000` (4 h) | Session ends after this total duration. |
| `user.id` | anonymous | Initial user id. Otherwise an anonymous id is generated and persisted (`ouo.user.anonymous=true`). |
| `debug` | `false` | Log SDK decisions to the console with the `[ouo]` prefix. |

## Sessions

Implements `docs/specs/session-lifecycle.md` for the web:

- State is persisted in `localStorage` under `ouo.session` (`{ id, startedAt, lastActivity, previousId, replaySeq, replaySampled, endedAt, endReason }`) and `ouo.user`.
- Activity: click, keydown, scroll, touchstart, pointerdown, tab becoming visible, navigation, outbound fetch/XHR. Persisted at most once per second.
- Ends: `inactivity` (30 min) or `max_duration` (4 h), detected by a timer in the tab, on the next init, or lazily when the next signal needs a session. The session is not rotated immediately on inactivity: the next activity or signal starts the new one with `session.previous_id` set.
- Tabs of the same origin share the session through the `storage` event; a session ended in one tab is not ended again by another.
- Web uncaught errors do not end the session; they mark it crashed (ADR-0004).

## Identifiers on every signal

Every span and log record carries `session.id`, `user.id`, `ouo.user.anonymous`,
`ouo.platform=web`, `service.version` and, for sessions that replaced an expired one,
`session.previous_id`. Outbound requests to `tracing.propagateTo` origins carry
`traceparent` and `baggage: session.id=…,user.id=…,ouo.platform=web`.

## Events emitted (OTel log records, `event.name`)

| `event.name` | When | Attributes |
|---|---|---|
| `session.start` | new session | `ouo.session.started_at` (epoch ms) |
| `session.end` | session expired | `ouo.session.end_reason`, `ouo.session.duration_ms`, `ouo.session.started_at`, `ouo.session.ended_at` |
| `exception` | uncaught error, unhandled rejection (fatal), `captureError`, `console.error`, resource load failure (non-fatal) | `exception.type`, `exception.message`, `exception.stacktrace`, `ouo.exception.fatal`, `ouo.exception.handled`, `ouo.exception.kind` (`uncaught`, `unhandledrejection`, `captured`, `console`, `resource`) |
| `http.request.failed` | fetch/XHR with status 5xx or a network failure (status 0). 4xx is not an error. | `http.request.method`, `url.full`, `http.response.status_code` |
| `navigation` | page load and `pushState` / `replaceState` / `popstate` | `url.path`, `url.full`, `ouo.navigation.from`, `ouo.navigation.kind` (`load`, `push`, `replace`, `pop`) |
| `web_vital` | web-vitals callbacks (TTFB, FCP, LCP, CLS, INP) | `ouo.web_vital.name`, `ouo.web_vital.value`, `ouo.web_vital.rating`, `ouo.web_vital.id`, `ouo.web_vital.delta`, `url.path` |
| custom | `rum.addEvent(name, attrs)` | your attributes plus `ouo.event.custom=true` |

Spans: `documentLoad` (and its resource fetches), one `CLIENT` span per fetch/XHR
(`http.request.method`, `url.full`, `http.response.status_code`, `server.address`).

## Replay (ADR-0003)

- rrweb `record` with `maskAllInputs` (default true), `checkoutEveryNms` 5 min, no canvas or font collection.
- Privacy classes: add `ouo-block` to an element to exclude it from the recording (rendered as a placeholder), `ouo-mask` to replace its text with asterisks. Inputs are masked by default.
- Chunks: `{ session_id, seq, started_at, ended_at, events }` (timestamps are epoch milliseconds), flushed every 5 s or at 256 KB, gzip-compressed with `CompressionStream`, `POST ${replayEndpoint}/v1/replay/chunks` with headers `content-type: application/json`, `content-encoding: gzip`, `authorization: Basic ...`, `x-ouo-session-id`, `x-ouo-seq`. On `pagehide` the remaining buffer is sent uncompressed with `fetch(..., { keepalive: true })`, same headers.
- `seq` is stored with the session, so a reload continues the sequence; every page load starts with a full snapshot. A new session resets `seq` to 0 and takes a fresh full snapshot.
- Upload failures retry 3 times with backoff; pending data is capped at 2 MB (oldest chunks dropped).
- `rum.replay.pause()` stops recording and flushes; `resume()` starts a new recording with a full snapshot.
- The collector's replay receiver must answer CORS preflights allowing the headers above (`Authorization`, `Content-Type`, `Content-Encoding`, `X-Ouo-Session-Id`, `X-Ouo-Seq`) for your origin; the OTLP receiver needs `Authorization` and `Content-Type` (ADR-0007 section 4).

## Debugging

With `debug: true` the SDK logs one init line with the URLs it derived and the project id, never the token:

```
[ouo] @ouo11y/browser@0.2.0 initialised { endpoint: "http://localhost:4318", replayEndpoint: "http://localhost:4319", traces: "http://localhost:4318/v1/traces", logs: "http://localhost:4318/v1/logs", replay: "http://localhost:4319/v1/replay/chunks", projectId: "demo", session: "...", user: "..." }
```

Common collector answers: `401` wrong or missing credential (basicauth), `429` or `503` rate limited (`ouoratelimit`, retried by the exporters), `413` payload too large, a CORS error with no POST at all when the page origin is not in the collector's `allowed_origins` or `Authorization` is missing from its allowed headers. Exporter responses are visible with the OTel diag logger (`debug: true` wires it to `console.warn`).

## Development

```bash
npm run -w sdk/browser build      # tsup -> dist/index.js (+ rrweb chunk, .d.ts)
npm run -w sdk/browser test       # vitest + jsdom (includes a real-socket check against collector stubs on 127.0.0.1:18081 and :18082)
npm run -w sdk/browser size       # gzip sizes
node sdk/browser/playground/server.mjs   # static playground on :4173 + collector stub on :8090 (OTLP + replay on one port, Basic-auth checked)
```

Tests run against the browser builds of the OTel packages (see `vitest.config.ts`).
