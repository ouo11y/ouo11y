# How the web SDK is built

`@ouo11y/browser` after ADR-0020. Paths are under `sdk/browser/src/`.

## One page

```text
browser events ─► signals/*  ─► pipeline/emitter ─► OTel Logger (scope ouo.rum) ─► RouterLogProcessor ─► transport/queue (logs)   ─► POST /v1/logs   JSON + gzip
fetch / XHR    ─► OTel instrumentations ─► OTel Tracer (scope ouo.rum) ─► RumSpanProcessor ─► transport/queue (traces) ─► POST /v1/traces JSON + gzip
DOM changes    ─► replay adapter ─► replay/engine ─► OTel Logger (scope ouo.replay) ─► RouterLogProcessor ─► engine's own queue ─► POST /v1/logs protobuf, one chunk per request
```

## Modules

| Module | Job |
|---|---|
| `index.ts` | The public functions and the `Runtime` that wires everything; consent state; page lifecycle; self-disable |
| `config.ts` | Turns any input into a full configuration or `null` (SDK off). Never throws |
| `guard.ts` | `attempt`, `guard`, `quiet`, `listen`: every hook goes through one of them. Counts contained failures, trips self-disable, and holds the fault-injection points (`point(name)`) |
| `core/` | Pure helpers with no DOM: ids and the sampling rule, URL sanitiser, attribute limits and reserved names, CSS selector, drop counter, clock |
| `session/manager.ts` | The session state machine over one `localStorage` record |
| `session/storage.ts` | `localStorage` with memory fallback; `ConsentStorage` stays in memory until consent |
| `pipeline/emitter.ts` | Where every SDK event is made: stamp, bypass, rate limit, truncate, `beforeSend`, hold until the session start is confirmed |
| `pipeline/otel.ts` | Resource, providers, span sampler and processor, log router, propagator, XHR header guard |
| `signals/` | Errors, web vitals, clicks and frustration, navigation and views, network wiring |
| `transport/` | One HTTP POST (`http.ts`), the telemetry queue and the outbox drainer (`queue.ts`), the outbox (`store.ts`), retry rules, keepalive budget, gzip |
| `replay/controller.ts` | In the core bundle: decides whether this session records, loads the engine and an adapter on demand |
| `replay/engine.ts` | Lazy: streams, segments, chunks, ring buffer, hashing, persistence, delivery, end records, recovery |
| `replay/structure.ts`, `replay/pixel.ts` | Lazy: the two format adapters behind `replay/adapter.ts` |

## Where OpenTelemetry ends

Used as is: `LoggerProvider` and the Logs API for every event and every replay chunk, `BasicTracerProvider`, `StackContextManager`, `W3CTraceContextPropagator`, the fetch and XHR instrumentations, the JSON and protobuf OTLP serializers, the browser resource detector.

Ours, because OpenTelemetry has nothing for it yet: the session and view, session sampling with a bypass set (a `Sampler` and the emitter), consent, URL sanitising, batching for page lifetimes (the OTel batch processors skip a flush requested while one is running, which loses the page-hide flush), the outbox, and replay.

Three places work around the OTel packages rather than through them, each small and contained:

- `RumSpanProcessor.onEnd` edits the ended span's attribute bag in place (sanitised `url.full`, truncation, `beforeSend`) and empties its events. The SDK version in use has an `onEnding` hook, but it cannot remove an attribute or drop a span.
- The bundled instrumentations are given a tracer provider whose every tracer is the `ouo.rum` tracer, so their spans carry the spec's scope.
- `installXhrHeaderGuard` wraps `XMLHttpRequest.prototype.setRequestHeader`, because the XHR instrumentation cannot see that the app already set `traceparent`.

## Rules that shaped the design

- **A record is stamped when it is made.** The emitter reads the session, view and URL at creation, not at export. `session.start` goes first because records made while a start is being confirmed under the Web Lock are held and released after it.
- **The session never starts because a record needs an id.** `stamp()` returns the last known id marked expired; only `activity()` starts a session.
- **Errors travel apart.** Bypass records are batched separately so a full queue can evict ordinary records first and a page close sends them first.
- **Nothing is stored before consent.** The outbox and `localStorage` are reached through functions that return nothing while consent is pending.
- **The page's own code never waits on the SDK.** No public function awaits; patched functions call the original first and do their own work after, guarded.
