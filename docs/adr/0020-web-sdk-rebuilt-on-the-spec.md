# ADR-0020: the web SDK is rebuilt on the client SDK spec, inside the same package

| | |
|---|---|
| Status | proposed (2026-11-12). The founder reviews and merges |
| Scope | `sdk/browser` (`@ouo11y/browser`), `examples/ouo-web` |
| Replaces | For the browser SDK only: the SDK parts of ADR-0002 (session ids, activity), ADR-0003 (replay transport and masking classes) and ADR-0007 section 6 (replay receiver for the browser) in `docs/adr-archive/` |

## Context

Step 5 of the post-MVP plan measured `@ouo11y/browser` 0.3.1 against the draft client SDK spec ([sdk-spec.md](../../project/kb/opentelemetry/rum-semantic-conventions/sdk-spec.md), `0.1.0-draft`): 42 of the 157 MUSTs that apply to the web were met, 38 partly, 77 not ([compliance.md](../../project/kb/client-sdk-state/compliance.md)). The gaps were not scattered bugs. They were six structural differences: replay was not OTLP, the names predated the spec, there was no privacy layer, sessions and sampling followed MVP rules, there was no drop accounting or self-disable, and the SDK registered its OpenTelemetry providers globally.

The founder's direction for the SDKs: keep what works or archive and rewrite; build on the OpenTelemetry API and SDK as far as possible and add only what OpenTelemetry lacks; borrow third-party code only where needed, Sentry first, then Datadog, then PostHog; record replay both as structure (a DOM description, text replaced by `***`) and as pixels; an SDK failure must never crash or break the host app; emit the spec wire only, with no compatibility mode for the MVP names.

## Decision

**Keep the package and what demonstrably worked; rewrite the modules that contradict the spec. No second package, no compatibility switch.**

Kept (they were sound and already sat on OpenTelemetry or on platform APIs):

| Kept | Why |
|---|---|
| The package, its build (tsup, terser, lazy chunks, the rrweb blocked-iframe patch), the size budget and the ES2022 check | Shipping shape was right |
| The OpenTelemetry JS SDK as the base: `LoggerProvider`, tracer provider, the fetch and XHR instrumentations, the OTLP serializers, the browser resource detector | The founder's direction; the audit found them correct |
| `guard` (contain every hook), the clock abstraction, gzip, the keepalive budget, the `localStorage` wrapper with memory fallback, the IndexedDB store's shape | Tested, and graded as met in Step 5 |
| The React entry and the debug-id attribute for source maps | Unchanged features |
| The e2e harness (collector stub, three engines) | Reused for the new specs |

Rewritten (their design, not their details, was against the spec):

| Rewritten | From | To |
|---|---|---|
| Public API | `initRUM()` returning an instance, MVP method names | Module functions with the spec's names, each a no-op that never throws before `init`, after `shutdown` and on the server |
| Configuration | Throws on a missing credential, unclamped values | Never throws; clamps; a no-op without `endpoint` or `serviceName` |
| Sessions | UUID, started when any record needed an id, network counted as activity | 32-hex id, started by user activity only, one emitter per `session.start` / `session.end` across tabs (Web Lock plus marks in the stored record), view id on every record |
| Sampling | Salted FNV hash; unsampled sessions sent nothing | The spec's hex-prefix rule; a bypass set for unhandled errors, marked and capped |
| Signals | `web_vital`, `navigation`, click and soft-navigation spans, `ouo.rage_click`, `http.request.failed`, console errors | The spec's events; spans only for requests and `documentLoad` (made after the fact by the SDK, replacing `@opentelemetry/instrumentation-document-load`, which cannot be told to emit no child spans) |
| Privacy | None | Consent (pending, granted, denied; telemetry and replay apart), URL sanitising, `beforeSend`, no user id before `setUser`, no device id |
| Transport | One queue of stored requests for everything; retried 500 and 408 | A telemetry queue per signal with the spec's response table, oldest-ordinary-first eviction and drop accounting; replay on its own queue |
| Replay | Custom JSON to a separate receiver on port 4319 | `ouo.replay.chunk` and `ouo.replay.ended` log records on `/v1/logs` as OTLP protobuf, made through the Logs API; an engine that owns the hierarchy and delivery; two format adapters behind one interface |
| Robustness | Counted contained failures | Counts them, reports drops as `ouo.sdk.dropped`, turns itself off at the threshold, and ships a fault-injection hook that the tests use in every internal |

The old sources are not copied to an archive folder: they are in git history at `browser-v0.3.1` (commit `27f7101e`), and an in-tree copy would be built, linted and link-checked for no reader.

### Replay formats

`structure` is the only format this release records. **`pixel` is under development and paused** (founder, 2026-11-12: not needed now). Its adapter stays in the package behind the format seam the spec requires (RPL-27), but configuration never selects it: `replay.format: "pixel"` records `structure` instead, with a diagnostic. Falling back was chosen over leaving replay off because an app that asked for replay gets a masked, supported recording rather than none. The table below records the design for when the work resumes.

| | `structure` | `pixel` |
|---|---|---|
| `ouo.replay.format` | `rrweb/2` | `ouo.frames/1` |
| When to look | rrweb's MutationObserver and input listeners | A MutationObserver, scroll, resize and input mark the page dirty; at most `pixelMaxFps` frames a second |
| What is recorded | DOM description; text is `***` | A masked clone of the page, drawn through SVG `foreignObject` to a canvas, as WebP or JPEG |
| Masking race | None: rrweb masks while serialising | None on the web: the live page is never drawn. Only a clone that was masked first is |

The pixel recorder is our own code (about 250 lines). None of Sentry, Datadog or PostHog records pixels on the web, so there was nothing to borrow.

### Third-party code

No source was copied from Sentry, Datadog or PostHog. Dependencies, each with its licence and reason:

| Dependency | Licence | Why |
|---|---|---|
| `@opentelemetry/api`, `api-logs`, `core`, `resources`, `sdk-logs`, `sdk-trace-base`, `sdk-trace-web`, `otlp-transformer`, `instrumentation`, `instrumentation-fetch`, `instrumentation-xml-http-request`, `opentelemetry-browser-detector`, `semantic-conventions` | Apache-2.0 | The base the SDK is built on. All were already dependencies |
| `web-vitals` | Apache-2.0 | The reference implementation of the vitals; now its attribution build, for INP attribution (SIG-02) |
| `rrweb` | MIT | The structure recorder. **A deviation from "Sentry first":** this is upstream `rrweb` 2.1.7, which the SDK already used and patched, not Sentry's fork (`@sentry-internal/rrweb`, also MIT). Sentry's fork adds unmasking by selector and other changes; the unmask rules here are done with upstream's `maskTextFn` / `maskInputFn`. Whether to move to Sentry's fork is open for the founder. Datadog's own serializer was not needed |
| Removed: `@opentelemetry/instrumentation-document-load` | | Replaced by a 20-line span made after `load` |

### OpenTelemetry globals

The tracer and logger providers are not registered globally unless `otel.registerGlobalProviders` is set (REL-4); the host reaches them with `getTracerProvider()` and `getLoggerProvider()` (REL-5). The fetch and XHR instrumentations use the context and propagation APIs, which exist only as globals, so the SDK registers a context manager and a propagator when the host has none, and leaves a host's own in place.

## Consequences

- **Breaking for apps.** `@ouo11y/browser` 0.4 has a new API and new wire names. The demo app (`examples/ouo-web`) is moved to it. The quickstarts pin older published versions and are unaffected until they are regenerated.
- **Spec compliance.** Every MUST of the spec that applies to the web is implemented; the record, per requirement, with the test that shows it, is in [web-sdk-compliance.html](../../project/kb/client-sdk-web/compliance/web-sdk-compliance.html).
- **The MVP read path sees less.** rum-api still lists the session, its timeline, traces and symbolicated errors from the new wire (verified with the demo journey). It does not know the new event names as vitals, clicks or navigations, and the Grafana plugin's player cannot play the new replay: chunks now arrive on `/v1/logs`, where the current collector configuration forwards them to Loki, body included. Nothing here changes rum-api, the plugin or the collector; that is the Muninn and plugin work of Steps 8 and 9.
- **Removed on purpose** (the spec or the target list says so): the anonymous user id and `device.id`, `console.error` as an error, `http.request.failed`, click and soft-navigation spans, long-task events (gated by SIG-30), `sendBeacon`, the multi-tab replay lease (streams are per page now), and `replay.excludeRoutes` (an app can call `replay.stop()` and `replay.start()`; a first-class never-record list is not in the spec and is left for Step 7 to decide).
- **Size.** Initial JavaScript is 49.4 KB gzip (0.3.1: 44.2; the Step 5 budget proposal: 50). Replay loads only when a session records: the engine 7.3 KB, then structure 55.4 KB or pixel 2.8 KB.
- **React Native** is not touched. No shared core package was created; the pure helpers RN may want (id and sampling rule, URL sanitiser, drop counter) are in `sdk/browser/src/core/`.
