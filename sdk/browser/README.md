# @ouo/browser

OpenTelemetry-native Real User Monitoring for the browser: sessions, errors, fetch/XHR
tracing with W3C Trace Context and Baggage, Web Vitals, navigation events and rrweb session
replay. Everything is exported as OTLP/HTTP (JSON) to an OpenTelemetry Collector; replay
chunks go to `rum-api`.

## Install

```bash
npm install @ouo/browser
```

ESM only, TypeScript types included. The main entry is about 40 KB gzipped; rrweb is a
separate chunk (about 82 KB gzipped) that is only downloaded when replay is enabled and the
session is sampled.

## Init

```ts
import { initRUM, type RUM } from "@ouo/browser";

const rum: RUM = initRUM({
  endpoint: "http://localhost:4328",        // OTLP/HTTP base; SDK appends /v1/traces and /v1/logs
  replayEndpoint: "http://localhost:8082",  // rum-api base; SDK posts to `${replayEndpoint}/v1/replay/chunks`
  service: { name: "web-store", version: "1.4.2", environment: "local" },
  tracing: { propagateTo: [/^http:\/\/localhost:8082/] },
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
the same instance.

## Options

| Option | Default | Meaning |
|---|---|---|
| `endpoint` | required | OTLP/HTTP base URL. `/v1/traces` and `/v1/logs` are appended. |
| `replayEndpoint` | none | rum-api base URL. Without it replay is disabled. |
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
- Chunks: `{ session_id, seq, started_at, ended_at, events }` (timestamps are epoch milliseconds), flushed every 5 s or at 256 KB, gzip-compressed with `CompressionStream`, `POST ${replayEndpoint}/v1/replay/chunks` with headers `content-type: application/json`, `content-encoding: gzip`, `x-ouo-session-id`, `x-ouo-seq`. On `pagehide` the remaining buffer is sent uncompressed with `fetch(..., { keepalive: true })`.
- `seq` is stored with the session, so a reload continues the sequence; every page load starts with a full snapshot. A new session resets `seq` to 0 and takes a fresh full snapshot.
- Upload failures retry 3 times with backoff; pending data is capped at 2 MB (oldest chunks dropped).
- `rum.replay.pause()` stops recording and flushes; `resume()` starts a new recording with a full snapshot.
- rum-api must answer CORS preflights allowing the headers above.

## Development

```bash
npm run -w sdk/browser build      # tsup -> dist/index.js (+ rrweb chunk, .d.ts)
npm run -w sdk/browser test       # vitest + jsdom
npm run -w sdk/browser size       # gzip sizes
node sdk/browser/playground/server.mjs   # static playground on :4173 + replay stub on :8090
```

Tests run against the browser builds of the OTel packages (see `vitest.config.ts`).
