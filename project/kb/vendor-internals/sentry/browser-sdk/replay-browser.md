# Sentry browser session replay internals

- SDK pinned: `@sentry/browser` **11.11.0** (2026-11-05); replay code lives in `@sentry-internal/replay` (`packages/replay-internal`), the compression worker in `packages/replay-worker`, canvas in `packages/replay-canvas`.
- rrweb fork: `@sentry/rrweb` + `@sentry/rrweb-snapshot` **2.45.0** (`B/packages/replay-internal/package.json#L78-L79`); compression: `fflate` **0.8.3** (`B/packages/replay-worker/package.json#L58`).
- Compared with: `@sentry/browser` **10.78.0** (`B10` = https://github.com/getsentry/sentry-javascript/blob/10.78.0), rrweb fork 2.44.1, fflate 0.8.2.
- Research date: 2026-11-10. `B` = https://github.com/getsentry/sentry-javascript/blob/11.11.0 . `R` = https://github.com/getsentry/relay/blob/26.10.0 (server side, only where noted).
- Paths below are relative to `B/packages/replay-internal/src/` unless they start with `packages/`.

Related: feature matrix in [../../../client-sdk-features/vendors/sentry-web.md](../../../client-sdk-features/vendors/sentry-web.md) (feature rows are not repeated here). Siblings: [wire-capture.md](wire-capture.md), [reliability.md](reliability.md), [sampling.md](sampling.md), [configuration.md](configuration.md).

---

## 0. Constants (all from `B/packages/replay-internal/src/constants.ts`)

| Constant | Value | Line |
|---|---|---|
| `REPLAY_SESSION_KEY` | `'sentryReplaySession'` | L9 |
| `REPLAY_EVENT_NAME` / `RECORDING_EVENT_NAME` | `'replay_event'` / `'replay_recording'` | L10-L11 |
| `SESSION_IDLE_PAUSE_DURATION` | 300 000 ms (5 min) | L15 |
| `SESSION_IDLE_EXPIRE_DURATION` | 900 000 ms (15 min) | L18 |
| `DEFAULT_FLUSH_MIN_DELAY` | 5 000 ms | L21 |
| `DEFAULT_FLUSH_MAX_DELAY` | 5 500 ms | L24 |
| `BUFFER_CHECKOUT_TIME` | 60 000 ms | L27 |
| `RETRY_BASE_INTERVAL` / `RETRY_MAX_COUNT` | 5 000 ms / 3 | L29-L30 |
| `NETWORK_BODY_MAX_SIZE` | 150 000 | L33 |
| `CONSOLE_ARG_MAX_SIZE` | 5 000 | L36 |
| `SLOW_CLICK_THRESHOLD` / `SLOW_CLICK_SCROLL_TIMEOUT` | 3 000 / 300 ms | L39-L41 |
| `REPLAY_MAX_EVENT_BUFFER_SIZE` | 20 000 000 (uncompressed JSON string length) | L44 |
| `MIN_REPLAY_DURATION` | 4 999 ms | L47 |
| `MIN_REPLAY_DURATION_LIMIT` | 50 000 ms (cap for user `minReplayDuration`) | L53 |
| `MAX_REPLAY_DURATION` | 3 600 000 ms (60 min) | L56 |

Integration option defaults (`integration.ts#L111-L148`): `flushMinDelay 5000`, `flushMaxDelay 5500`, `minReplayDuration 4999` (clamped to ≤ 50 000, `#L200`), `maxReplayDuration 3 600 000` (clamped to ≤ 60 min, `#L201`), `stickySession true`, `useCompression true`, `maskAllText true`, `maskAllInputs true`, `blockAllMedia true`, `mutationBreadcrumbLimit 750`, `mutationLimit 10 000`, `slowClickTimeout 7000`, `networkCaptureBodies true`, `networkDetailAllowUrls []`, `maskAttributes ['title','placeholder','aria-label']`, `attachRawBodyFromRequest false`. Sample rates come from client options `replaysSessionSampleRate` / `replaysOnErrorSampleRate`, both default 0 (`integration.ts#L424-L454`).

---

## 1. Lifecycle

### 1.1 ReplayContainer and recording modes

`ReplayContainer` (`replay.ts#L68`) holds the session, event buffer, flush debouncer and listeners. `recordingMode` is `'session' | 'buffer'` (`replay.ts#L79-L86`, type `B/packages/core/src/types/replay.ts#L28`):

- **session**: record and send continuously.
- **buffer**: record in memory only; sent when an error is sampled or `flush()` is called.

Initial sampling (`initializeSampling`, `replay.ts#L325-L361`):

1. If `errorSampleRate <= 0 && sessionSampleRate <= 0` → nothing starts; user must call `start()` / `startBuffering()` (`#L330-L336`).
2. Load or create a session (`_initializeSessionForSampling`, `#L903-L922`); buffering is allowed whenever `errorSampleRate > 0` (`#L906`).
3. `sampled` = `'session'` if `Math.random() < sessionSampleRate`, else `'buffer'` if buffering allowed, else `false` (`session/createSession.ts#L9-L11`, `util/isSampled.ts#L13`). `false` → nothing recorded (`replay.ts#L348-L352`).
4. `recordingMode = sampled === 'buffer' && segmentId === 0 ? 'buffer' : 'session'` (`#L356`) — a stored buffer session that already sent a segment continues in session mode.

`start()` forces a session-mode replay with `sessionSampleRate: 1, allowBuffering: false` (`replay.ts#L389-L403`); `startBuffering()` uses `sessionSampleRate: 0, allowBuffering: true` (`#L420-L435`).

### 1.2 Session object and storage

`makeSession` (`session/Session.ts#L7-L27`) fields:

| Field | Meaning |
|---|---|
| `id` | uuid4 hex (32 chars, no dashes); **this is the `replay_id`** (`Session.ts#L9`, `replay.ts#L742-L748`) |
| `started` | ms epoch; in buffer mode moved to the earliest buffered event on each checkout (`util/handleRecordingEmit.ts#L89-L101`) |
| `lastActivity` | ms epoch of last *user* activity |
| `segmentId` | next segment number, starts 0 |
| `sampled` | `'session' \| 'buffer' \| false` |
| `previousSessionId` | id of the expired session this one replaced |
| `dirty` | set `true` when an error was sampled in buffer mode before the buffer was sent (`coreHandlers/handleGlobalEvent.ts#L102-L109`); reset to `false` on conversion (`replay.ts#L623`) |

Persisted as JSON under `sessionStorage['sentryReplaySession']` when `stickySession` (default true) (`session/saveSession.ts#L14`, `session/fetchSession.ts#L18`); i.e. one replay per tab, surviving reloads within the tab. `stop()` clears it (`replay.ts#L546`).

### 1.3 Idle pause, expiry, max duration

- **Expired** = `now >= started + maxReplayDuration` OR `now >= lastActivity + sessionIdleExpire` (`util/isSessionExpired.ts#L15-L21`, `util/isExpired.ts#L16-L20`).
- **Refresh** needed = expired, except a buffer session that never flushed (`sampled==='buffer' && segmentId===0`) is never refreshed (`session/shouldRefreshSession.ts#L10-L17`).
- **Idle pause**: `checkAndHandleExpiredSession()` pauses rrweb if the in-memory `_lastActivity` is older than 5 min and `sampled === 'session'` (`replay.ts#L763-L774`). Pause stops DOM recording; nothing is added (`#L557-L566`, `util/addEvent.ts#L120`). Pause is lazy: it happens on the next call to this check (an emit, breadcrumb, flush, visibility change), not on a timer.
- **Resume**: a user action (`ui.click`, `ui.input`, history navigation) calls `triggerUserActivity()` → `resume()` → `startRecording()` → **new full snapshot in the same replay** (`replay.ts#L667-L688`, `#L574-L583`). `keydown` only updates activity and does not resume (`replay.ts#L697-L700`, `coreHandlers/handleKeyboardEvent.ts#L14-L17`).
- **Refresh on expiry**: `_checkSession()` → `_refreshSession()` → `stop({reason:'sessionExpired'})` (no flush) → `initializeSampling(oldId)` → new session with `previousSessionId`, new `id`, `segmentId 0`, re-sampled (`replay.ts#L928-L963`, `session/loadOrCreateSession.ts#L32-L37`). The first checkout of a refreshed session is **not** flushed immediately; it waits for a follow-up action (`handleRecordingEmit.ts#L103-L111`).
- **Hard caps**: events with timestamp > `initialTimestamp + maxReplayDuration` are dropped (`util/addEvent.ts#L134-L139`); events older than 5 min (`sessionIdlePause`) are dropped (`#L126-L132`); a flush with `now - session.started > maxReplayDuration + 5 s` is skipped (`replay.ts#L1307`); `_runFlush` throws `ReplayDurationLimitError` if `now - initialTimestamp > maxReplayDuration + 30 s`, which stops the replay with drop reason `invalid` (`replay.ts#L1221-L1223`, `#L1258-L1259`).

### 1.4 Checkouts (full snapshots)

`startRecording()` calls `rrweb.record()` (`replay.ts#L443-L480`):

- **buffer mode**: `checkoutEveryNms: BUFFER_CHECKOUT_TIME` = 60 s (`#L452-L453`).
- **session mode**: no periodic checkout by default. Only with `_experiments.continuousCheckout` is `checkoutEveryNms = max(360 000, value)` (≥ 6 min) (`#L461-L464`).
- Every `startRecording()` (init, resume after idle, buffer→session conversion) installs a new emit handler whose first event counts as a checkout (`handleRecordingEmit.ts#L24`, `#L39-L42`) → new Meta + FullSnapshot.

So in a default session-mode replay, full snapshots appear only at segment 0 and after each resume or conversion, **not** every N minutes.

**How the buffer keeps "the last 60 s"**: on each buffer-mode checkout the event buffer is cleared (`util/addEvent.ts#L65-L67`) and the context (error ids, trace ids, urls, initialTimestamp) is reset (`handleRecordingEmit.ts#L57-L59`, `replay.ts#L791-L804`). The buffer therefore holds **everything since the last checkout (0–60 s)**, not a sliding 60-s window. If the buffer overflows in buffer mode it is cleared and waits for the next checkout (`util/addEvent.ts#L104-L110`).

### 1.5 Buffer → session conversion on error

1. Global event processor (`coreHandlers/handleGlobalEvent.ts#L16-L114`): for an error event in buffer mode, `shouldSampleForBufferEvent` requires `event.exception`, no `event.type`, no synthetic stacktrace, message ≠ `'Unable to send Replay'`, then `Math.random() < errorSampleRate` (`coreHandlers/util/shouldSampleForBufferEvent.ts#L11-L31`). If sampled (or in session mode) → `event.tags.replayId = <session id>` (`handleGlobalEvent.ts#L91-L95`) and `session.dirty = true` (`#L102-L109`).
2. `afterSendEvent` hook, only on HTTP 2xx (`coreHandlers/handleAfterSendEvent.ts#L18-L24`): adds `event_id` to `errorIds` (max 100, `#L48-L50`); if buffer mode and `tags.replayId` is set and `beforeErrorSampling(event)` is not false → `setTimeout(() => replay.sendBufferedReplayOrFlush())` (`#L54-L70`).
3. `sendBufferedReplayOrFlush` (`replay.ts#L592-L631`): `flushImmediate()` sends the buffer as **segment 0** (checkout + events up to now), then `stopRecording()`, `recordingMode = 'session'`, `dirty = false`, activity reset, `replay_id` written into the cached DSC, `startRecording()` → new full snapshot that starts segment 1. Pass `continueRecording: false` to send only the buffer.
4. `session.sampled` stays `'buffer'`, so **every segment of an error-triggered replay carries `replay_type: "buffer"`** (`util/sendReplayRequest.ts#L50`).

---

## 2. Segment flushing and the wire

This section says where the SDK builds each part, with code lines. The normative description of the replay items as Relay accepts them is [../wire-format/replay-wire.md](../wire-format/replay-wire.md); how Sentry stores them is [../self-hosted-storage/object-storage.md](../self-hosted-storage/object-storage.md#replay-segments).

### 2.1 When a segment is flushed

- Every added event calls `addUpdate()` → `_debouncedFlush()` (session mode only, `replay.ts#L641-L660`). Debounce: `wait = flushMinDelay` (5 s), `maxWait = flushMaxDelay` (5.5 s) (`replay.ts#L208-L210`, `B/packages/core/src/utils/debounce.ts#L38`, `#L66-L67`). Console breadcrumbs do not schedule a flush (`coreHandlers/util/addBreadcrumbEvent.ts#L36`).
- First checkout in session mode calls `replay.flush()` (debounced), so segment 0 leaves ~5 s after start (`handleRecordingEmit.ts#L113-L122`).
- Page hidden (`visibilitychange` → hidden) or window `blur` → `conditionalFlush()` = immediate flush in session mode (`replay.ts#L245-L264`, `#L1018-L1043`, `#L705-L711`). `blur`/`focus` also add `ui.blur`/`ui.focus` breadcrumbs.
- `_flush` (`replay.ts#L1272-L1352`): returns if disabled; runs expiry check; skips if `now - session.started < minReplayDuration` (re-arms debounce) or `> maxReplayDuration + 5 s` (`#L1306-L1320`). Flush lock: a single `_runFlush` promise; concurrent callers await it and then schedule one more debounced flush (`#L1328-L1351`).
- `_runFlush` (`replay.ts#L1184-L1266`): adds buffered performance entries + a `memory` span (`#L1192`, `#L1200`), pops the context, **increments `segmentId` before sending regardless of outcome** (`#L1226-L1228`), drains the buffer (`#L1231`), calls `sendReplay`. Any final failure → `stop({reason:'sendError'})` and a client-report drop (`ratelimit_backoff` / `invalid` / `send_error`) (`#L1242-L1264`). Segment ids are therefore contiguous per replay only if no segment failed; a failed segment ends the replay.

### 2.2 Retries and rate limits

`sendReplay` (`util/sendReplay.ts#L10-L71`): transport exceptions are retried up to `RETRY_MAX_COUNT` = 3 times with waits 5 s, 10 s, 30 s (`interval *= ++count`, `#L57-L58`), i.e. 4 attempts. `TransportStatusCodeError` (non-2xx) and `RateLimitError` are **not** retried (`#L28-L30`). `sendReplayRequest` raises `RateLimitError` when `updateRateLimits` marks category `replay` limited (429 or `X-Sentry-Rate-Limits`) (`util/sendReplayRequest.ts#L120-L124`) and `TransportStatusCodeError` for any status outside 200–299 (`#L127-L129`). Either stops the replay for good (new replay only after a new session).

### 2.3 Envelope layout

`createReplayEnvelope` (`util/createReplayEnvelope.ts#L14-L29`) → two items; serialized by `serializeEnvelope` as `header\nitemHeader\npayload\nitemHeader\npayload` (`B/packages/core/src/utils/envelope.ts#L90-L125`):

```
{"event_id":"<replay_id>","sent_at":"<ISO>","sdk":{...}}                    <- envelope header
{"type":"replay_event"}
{"type":"replay_event","replay_id":...,"segment_id":N,...}                  <- JSON
{"type":"replay_recording","length":<byte length of payload>}
{"segment_id":N}\n<recording bytes>                                          <- binary
```

- Envelope header: `event_id` = replay id, `sent_at`, `sdk`, `dsn` only with tunnel, `trace` = DSC only if `event.sdkProcessingMetadata.dynamicSamplingContext` exists (`envelope.ts#L237-L253`). `sdkProcessingMetadata` is deleted from the replay event before the envelope is built (`util/sendReplayRequest.ts#L99-L101`), so `trace` is absent on replay envelopes (inferred from code order; not captured on the wire).
- `replay_recording.length` = UTF-8 byte length (string) or `Uint8Array.length` (`createReplayEnvelope.ts#L24-L25`).

### 2.4 `replay_event` payload

Built in `util/sendReplayRequest.ts#L40-L51`, enriched by `prepareReplayEvent` (`util/prepareReplayEvent.ts#L7-L62`):

| Field | Source |
|---|---|
| `type` | `"replay_event"` |
| `replay_id` | session id |
| `segment_id` | integer, 0-based |
| `replay_start_timestamp` | `initialTimestamp / 1000` (float seconds); initialTimestamp = recording start or earliest buffered event on segment 0 (`replay.ts#L1139-L1156`) |
| `timestamp` | flush time `/ 1000` (float seconds) |
| `error_ids` | event ids of errors sent while this segment accumulated (max 100) |
| `trace_ids` | trace ids of transactions / segment spans (max 100) (`coreHandlers/util/addSegmentDetailsToContext.ts#L3-L13`, `coreHandlers/handleProcessSegmentSpan.ts#L7-L14`) |
| `segment_names` | transaction / segment span names (max 100) (same) |
| `urls` | URLs visited during the segment (initial URL on checkout + history pushes) (`replay.ts#L803`, `coreHandlers/handleHistory.ts#L37`) |
| `replay_type` | `session.sampled`: `"session"` or `"buffer"` |
| `event_id` | = replay id (`prepareReplayEvent.ts#L25`) |
| `platform` | `"javascript"` (`#L48`) |
| `sdk` | `{name, version, settings, integrations}` (`#L54-L59`) |
| `environment`, `release`, `dist`, `tags`, `user`, `contexts`, `extra` | from scope via core `prepareEvent` (`#L29-L36`); `breadcrumbs` removed (`handleGlobalEvent.ts#L39-L44`) |
| `request` | added by `httpContextIntegration` in the `preprocessEvent` hook (`prepareReplayEvent.ts#L27`, `B/packages/browser/src/integrations/httpcontext.ts#L19-L40`) |

Type: `B/packages/core/src/types/replay.ts#L7-L16`. The event is sent only if `session.sampled` is truthy (`sendReplayRequest.ts#L36`).

### 2.5 `replay_recording` payload, byte for byte

- Header line: `JSON.stringify({segment_id})` + `"\n"` (exactly `{"segment_id":N}\n`) (`util/prepareRecordingData.ts#L16-L28`, header built in `sendReplayRequest.ts#L22-L27`).
- Body when compression is active: **zlib (RFC 1950) stream of the UTF-8 JSON array** of rrweb events. The worker uses fflate `Zlib` streaming (`B/packages/replay-worker/src/Compressor.ts#L1`, `#L63-L79`): pushes `[`, then each event JSON prefixed by `,` after the first (`#L31-L42`), then `]` with `final=true` (`#L47-L58`). fflate's zlib header at default level 6 is **`0x78 0x9C`** (verified locally with fflate's `Zlib`; not gzip `0x1f 0x8b`, not raw deflate).
- Body without compression: plain UTF-8 JSON array `[{...},{...}]` (`eventBuffer/EventBufferArray.ts#L56-L65`). A reader must sniff: after the first `\n`, `0x78` → zlib-inflate; `[` → plain JSON.
- `useCompression` defaults to `true` (`integration.ts#L117`). The worker is a Blob URL built from an inlined script (`B/packages/replay-worker/src/index.ts#L13-L14`) unless `workerUrl` is set or the bundle defines `__SENTRY_EXCLUDE_REPLAY_WORKER__` (`eventBuffer/index.ts#L19-L62`).
- Worker fallback: `EventBufferProxy` starts with the uncompressed array buffer, waits for the worker's `init` message (`B/packages/replay-worker/src/_worker.ts#L6-L11`, `eventBuffer/WorkerHandler.ts#L42-L67`), then replays buffered events into the worker and switches (`eventBuffer/EventBufferProxy.ts#L97-L141`). If the worker errors (CSP, load failure) the array buffer stays in use and segments go out uncompressed (`#L98-L105`). `finish()` waits for this decision, so one segment is never mixed (`#L84-L89`). The `options` event records `useCompression` = whether the buffer type was `'worker'` at the time (`handleRecordingEmit.ts#L202`).
- Size limit: `REPLAY_MAX_EVENT_BUFFER_SIZE` 20 000 000 counted as the sum of `JSON.stringify(event).length` (UTF-16 code units, pre-compression) (`EventBufferArray.ts#L45-L53`, `eventBuffer/EventBufferCompressionWorker.ts#L63-L77`). Overflow → `EventBufferSizeExceededError`; client report `buffer_overflow`; buffer mode: clear and wait for next checkout; session mode: `stop({reason:'eventBufferOverflow'})` (`util/addEvent.ts#L93-L114`). Other buffer errors → `stop({reason:'eventBufferError'})`.
- Mutation limits (`replay.ts#L1362-L1405`): a single rrweb mutation batch with `count > mutationBreadcrumbLimit` (750) adds a `replay.mutations` breadcrumb `{count, limit:false}`; `count > mutationLimit` (10 000) adds it with `limit:true` and stops the replay (`reason:'mutationLimit'`, flushing first if in session mode).
- Throttle: custom events added through `throttledAddEvent` (breadcrumbs, performance spans) are capped at 300 per 5 s; the first throttled one emits a `replay.throttled` breadcrumb (`replay.ts#L212-L218`, `#L810-L838`, `util/throttle.ts#L13-L55`). rrweb DOM events are not throttled (`handleRecordingEmit.ts#L63`).
- Stop reasons emitted via `client.emit('replayEnd')`: `manual | sessionExpired | sendError | mutationLimit | eventBufferError | eventBufferOverflow` (`B/packages/core/src/types/replay.ts#L40-L46`, `replay.ts#L522-L523`).

---

## 3. Recording content

### 3.1 rrweb event types

`types/rrweb.ts#L4-L10`: `0` DomContentLoaded, `1` Load, `2` FullSnapshot, `3` IncrementalSnapshot, `4` Meta, `5` Custom, `6` Plugin. Sentry emits 2/3/4 from rrweb and 5 for its own frames. IncrementalSnapshot sources follow upstream rrweb 2.x (`0` Mutation, `1` MouseMove, `2` MouseInteraction, `3` Scroll, `4` ViewportResize, `5` Input, `6` TouchMove, `7` MediaInteraction, `8` StyleSheetRule, `9` CanvasMutation, `10` Font, `11` Log, `12` Drag, `13` StyleDeclaration, `14` Selection, `15` AdoptedStyleSheet, `16` CustomElement) — from upstream rrweb, **not verified against the 2.45.0 fork source** (not in the clone). Sentry's own code relies on `Mutation` and `MouseInteraction`/`Scroll` (`util/handleRecordingEmit.ts#L135-L141`, `coreHandlers/handleClick.ts#L323-L345`). On iOS/iPadOS `mousemove` sampling is disabled (`util/getRecordingSamplingOptions.ts#L9-L21`).

Recording options passed to rrweb (`integration.ts#L159-L195`): `slimDOMOptions:'all'`, `inlineStylesheet:true`, `inlineImages:false`, `collectFonts:true`, `maskInputOptions:{password:true}`, `recordCrossOriginIframes` only by experiment.

### 3.2 Custom events (type 5)

Shape `{type:5, timestamp, data:{tag, payload, metric?}}` (`types/replayFrame.ts#L215-L249`).

**Timestamp units are mixed** (convert with `timestampToMs`, threshold `> 9 999 999 999` ⇒ ms, `util/timestamp.ts#L4-L7`):

| Producer | outer `timestamp` | payload time fields |
|---|---|---|
| rrweb events (2/3/4) | ms | — |
| breadcrumbs via `addBreadcrumbEvent` (click, input, keyDown, console, navigation, slow/multi click, hydrate-error, custom) | ms (`breadcrumb.timestamp * 1000`, `coreHandlers/util/addBreadcrumbEvent.ts#L27`) | `payload.timestamp` seconds (`util/createBreadcrumb.ts#L9-L13`) |
| `ui.blur`, `ui.focus`, `replay.mutations` via `_createCustomBreadcrumb` | **seconds** (`replay.ts#L1088-L1101`) | seconds |
| `replay.throttled` | **seconds** (`replay.ts#L825-L833`) | seconds |
| `performanceSpan` | **seconds** (`timestamp: start`, `util/createPerformanceSpans.ts#L14`) | `startTimestamp`/`endTimestamp` seconds |
| `options` | ms (`Date.now()`, `util/handleRecordingEmit.ts#L191`) | — |

#### `tag: 'breadcrumb'`

Payload `{timestamp, type:'default', category, message?, data?}` (`types/replayFrame.ts#L15-L24`), normalized to depth 10 / 1000 props (`addBreadcrumbEvent.ts#L31`).

| category | Source | Notes |
|---|---|---|
| `ui.click` | DOM click (`coreHandlers/handleDom.ts#L84-L87`) | `data.nodeId` + `data.node {id, tagName, textContent, attributes}` linking to the rrweb mirror id (`handleDom.ts#L55-L71`) |
| `ui.input` | DOM `keypress` renamed `input` (`B/packages/browser-utils/src/instrumentation/dom.ts#L253`) | |
| `ui.keyDown` | keydown with modifier or non-character key only; never inside input/textarea/contenteditable (`coreHandlers/handleKeyboardEvent.ts#L36-L64`) | data `{metaKey, shiftKey, ctrlKey, altKey, key, nodeId, node}` |
| `ui.slowClickDetected` | click with no mutation within 3 s and no scroll within 300 ms; timeout 7 s (`coreHandlers/handleClick.ts#L226-L250`) | data adds `url, route, timeAfterClickMs, endReason ('mutation'\|'timeout'), clickCount` |
| `ui.multiClick` | ≥ 2 clicks on same node (`handleClick.ts#L254-L270`) | `clickCount`, `metric:true` |
| `ui.blur` / `ui.focus` | window blur/focus (`replay.ts#L256-L274`) | |
| `console` | core console breadcrumbs (`coreHandlers/handleBreadcrumbs.ts#L53-L55`) | args > 5 000 chars truncated with `…` and `_meta.warnings:['CONSOLE_ARG_TRUNCATED']` (`#L61-L111`) |
| `navigation` and any custom category | core breadcrumbs pass through unless category is `fetch`, `xhr`, `sentry.event`, `sentry.transaction`, or starts with `ui.` (`handleBreadcrumbs.ts#L36-L58`) | |
| `replay.mutations` | mutation limits (§2.5) | `{count, limit}` |
| `replay.throttled` | throttle (§2.5) | `metric:true` |
| `replay.hydrate-error` | React hydration error events (`coreHandlers/handleBeforeSendEvent.ts#L23-L48`) | `{url}` |
| `sentry.feedback` | user feedback (`coreHandlers/util/addFeedbackBreadcrumb.ts`) | `{feedbackId}` |

fetch/xhr are **not** breadcrumbs in the recording; they are `performanceSpan`s.

#### `tag: 'performanceSpan'`

Payload `{op, description, startTimestamp, endTimestamp, data}` (`util/createPerformanceSpans.ts#L11-L25`). Entries are collected by a PerformanceObserver and converted at flush time (`replay.ts#L1107-L1125`).

| op | description | data | Source |
|---|---|---|---|
| `navigation.navigate` / `navigation.reload` / `navigation.back_forward` | URL | `size, decodedBodySize, encodedBodySize, duration, domInteractive, domContentLoadedEventStart/End, loadEventStart/End, domComplete, redirectCount` (zero-duration entries dropped) | `util/createPerformanceEntries.ts#L114-L157` |
| `navigation.push` | new URL | `{previous}` | `coreHandlers/handleHistory.ts#L5-L19` |
| `resource.<initiatorType>` (`css`, `img`, `script`, `link`, `iframe`, `other`, ...) | URL | `size, statusCode, decodedBodySize, encodedBodySize`; `fetch`/`xmlhttprequest` initiators skipped | `createPerformanceEntries.ts#L159-L191` |
| `resource.fetch` / `resource.xhr` | URL | `{method, statusCode, request?, response?}`; bodies/headers only for `networkDetailAllowUrls` | `coreHandlers/util/networkUtils.ts#L85-L109`, `fetchUtils.ts#L39`, `xhrUtils.ts#L34` (details: [wire-capture.md](wire-capture.md)) |
| `paint` | e.g. `first-contentful-paint` | none | `createPerformanceEntries.ts#L101-L112` |
| **`web-vital`** | `largest-contentful-paint` / `cumulative-layout-shift` / `interaction-to-next-paint` | `{value, size, rating, nodeIds, attributions?}`; start = end | `createPerformanceEntries.ts#L196-L273` (op literal at `#L262`) |
| `memory` | `memory` | `{memory:{jsHeapSizeLimit,totalJSHeapSize,usedJSHeapSize}}`, once per flush, Chromium only | `util/addMemoryEntry.ts#L32-L50` |

Note: the TypeScript type claims the web-vital `op` is the metric name (`types/replayFrame.ts#L173-L176`), but the runtime value is `op:'web-vital'` with the metric name in `description`. A converter must key on `description`.

#### `tag: 'options'`

Added once, after the first checkout of segment 0 only (`util/handleRecordingEmit.ts#L216-L223`). Payload (`#L187-L210`, type `types/replayFrame.ts#L122-L135`):

`shouldRecordCanvas`, `sessionSampleRate`, `errorSampleRate`, `useCompressionOption` (configured), `blockAllMedia`, `maskAllText`, `maskAllInputs`, `useCompression` (actual: buffer type was `worker`), `networkDetailHasUrls`, `networkCaptureBodies`, `networkRequestHasHeaders`, `networkResponseHasHeaders`. The header flags are always true in practice because `content-length`, `content-type`, `accept` are prepended to the header lists (`integration.ts#L27`, `#L456-L458`).

`beforeAddRecordingEvent` can rewrite or drop any type-5 event (not rrweb DOM events) (`util/addEvent.ts#L144-L159`).

### 3.3 Canvas

`replayCanvasIntegration` passes `recordCanvas:true`, a `getCanvasManager`, and quality presets `low` (`sampling.canvas:1` fps, webp q 0.25), `medium` (default, 2 fps, webp 0.4), `high` (4 fps, webp 0.5), max size 1280×1280 (`B/packages/replay-canvas/src/canvas.ts#L35-L78`). The fork's `CanvasManager` emits canvas frames as IncrementalSnapshot source `9` (CanvasMutation) with a `drawImage` of a webp blob (upstream rrweb behaviour; **exact command shape not verified against fork 2.45.0**). Not Plugin (type 6) events.

### 3.4 Privacy masking defaults

- `maskAllText:true`, `maskAllInputs:true`, `blockAllMedia:true` (`integration.ts#L120-L122`); passwords always masked (`#L162`).
- Mask selectors: user `mask` + `.sentry-mask, [data-sentry-mask]`; block: user `block` + `.sentry-block, [data-sentry-block], base, iframe[srcdoc]:not([src])`; ignore (input events dropped): `.sentry-ignore, [data-sentry-ignore], input[type="file"]` (`util/getPrivacyOptions.ts#L28-L41`).
- `blockAllMedia` appends `img,image,svg,video,object,picture,embed,map,audio,link[rel="icon"],link[rel="apple-touch-icon"]` to the block selector and ignores CSS `background-image` (`integration.ts#L24-L25`, `#L225-L232`).
- Attributes `title`, `placeholder`, `aria-label` are masked when `maskAllText` (`integration.ts#L137`, `#L165-L173`).
- Masked text appears as the same text with each non-whitespace character replaced by `*` (rrweb default when no `maskFn`), so length and spacing are kept. Blocked elements are serialized as placeholders with `rr_width`/`rr_height` attributes. Both are rrweb-snapshot behaviour, **not verified against the fork source**.

---

## 4. Error and trace linking

- **Error → replay (SDK side)**: the global event processor sets `event.tags.replayId` on errors, transactions and feedback when in session mode or when an error was sampled in buffer mode (`coreHandlers/handleGlobalEvent.ts#L87-L95`). The SDK does not write `contexts.replay`.
- **DSC**: `createDsc` hook sets `dsc.replay_id` only in session mode with an active session (`util/addGlobalListeners.ts#L35-L45`); cached DSCs are patched on start/conversion (`util/resetReplayIdOnDynamicSamplingContext.ts#L30-L41`, `replay.ts#L895-L897`, `#L627`) and cleared on stop/expiry (`#L7-L20`, `replay.ts#L528`, `#L1029`). DSC goes in the envelope header `trace.replay_id` of error/transaction envelopes (`B/packages/core/src/types/envelope.ts#L19-L30`, `B/packages/core/src/utils/envelope.ts#L249-L251`). Buffered (not yet sent) replays never appear in DSC.
- **`contexts.replay.replay_id`** on error events is added by Relay from the envelope DSC `replay_id` (`R/relay-server/src/processing/utils/event.rs#L297`, `R/relay-event-normalization/src/event.rs#L378-L387`). So the error that triggers a buffer flush is linked by `tags.replayId`, not by DSC/context.
- **Replay → errors**: `error_ids` on each `replay_event` lists errors acknowledged (2xx) during that segment (`coreHandlers/handleAfterSendEvent.ts#L48-L50`).
- **Replay → traces**: `trace_ids` and `segment_names` come from successfully sent transactions (`handleAfterSendEvent.ts#L35-L37`) and from streamed segment spans (`processSegmentSpan`, `util/addGlobalListeners.ts#L47`). Streamed spans also get `sentry.replay_id` and, in buffer mode, `sentry._internal.replay_is_buffering:true` (`integration.ts#L369-L377`).

---

## 5. Timeline (default options, session mode, values for an SVG)

| t | Event | Source |
|---|---|---|
| 0 | init: session `{segmentId:0, started:t0}` stored; rrweb Meta (4) + FullSnapshot (2); `options` event | §1.1, §3.2 |
| 0 → 5.0 s | debounce armed by first checkout (`wait 5 000`, `maxWait 5 500`) | `replay.ts#L208-L210` |
| ≈5.0–5.5 s | **segment 0** sent (needs `now - started ≥ 4 999 ms`) | `replay.ts#L1306` |
| any later | each burst → segment N+1 5 s after last event, at most 5.5 s after the first un-flushed one; hidden/blur → immediate | §2.1 |
| — | no periodic full snapshot in session mode (buffer mode: every 60 s; `continuousCheckout` experiment: every ≥ 6 min) | `replay.ts#L452-L464` |
| last activity + 5 min | recording paused (lazily, on next check) | `replay.ts#L763-L774` |
| user returns < 15 min idle | resume → new FullSnapshot, same replay_id, segments continue | `replay.ts#L667-L688` |
| last activity + 15 min | session expired → next activity creates new replay_id (`previousSessionId` = old), segment 0 again | §1.3 |
| started + 60 min | max duration: events past this dropped; session refreshed on next check | `util/addEvent.ts#L135`, `isSessionExpired.ts#L17` |
| started + 60 min + 5 s / + 30 s | flush skipped / replay stopped (`invalid`) | `replay.ts#L1307`, `#L1221` |

Buffer mode: checkouts at 0, 60, 120 s ... each clearing the buffer; error at t_e → segment 0 = [last checkout, t_e + async], then new checkout starts segment 1 in session mode with `replay_type:"buffer"`. Retries after a failed send: +5 s, +10 s, +30 s, then stop.

---

## 6. Differences vs 10.78.0

Wire format, constants, defaults, session model, compression and segment mechanics are **unchanged** (`constants.ts` and `replay-worker/src` are identical; `diff -r` shows only the files below).

| Area | 10.78.0 | 11.11.0 |
|---|---|---|
| rrweb fork | 2.44.1 (`B10/packages/replay-internal/package.json#L85-L86`) | 2.45.0 |
| fflate | 0.8.2 (`B10/packages/replay-worker/package.json#L66`) | 0.8.3 (same zlib output format) |
| web-vital span time | `getAbsoluteTime(value)` = timeOrigin + metric value (`B10/packages/replay-internal/src/util/createPerformanceEntries.ts#L245`) | last entry `startTime`, else `navigationStartTime + value` (`createPerformanceEntries.ts#L258-L259`) |
| performance → absolute time | `(timeOrigin + time)/1000` at flush | `_INTERNAL_performanceTimeToSeconds(time, entryStartTime)` so durations survive time-origin drift (`#L94-L99`, `#L141`, `#L182`) |
| route for slow clicks | `spanToJSON().data[sentry.source]`, `.description` | `attributes['sentry.segment.name.source']`, `.name` (`replay.ts#L844-L858`) |
| buffer error sampling | — | ignores errors with `hasDefaultSyntheticStacktrace` (`shouldSampleForBufferEvent.ts#L27-L29`) |
| slow-click detection | mutation/scroll at Δ=0 ignored | Δ=0 counts (`handleClick.ts#L186-L190`, `#L218-L220`) |
| feedback widget | replay id taken at send | replay id captured when widget opens; skip if session refreshed (`util/addGlobalListeners.ts#L59-L88`, `handleGlobalEvent.ts#L60-L66`) |
| event-processor drop | recorded twice (`event_processor`) | recorded once (`sendReplayRequest.ts#L56`) |
| span attribute | literal `'sentry.replay_id'` | `SENTRY_REPLAY_ID` constant (same key, from `@sentry/conventions`) |

---

## Unverified / open

- rrweb fork 2.45.0 internals (incremental source numbering, mask character, canvas command shape, Meta-before-FullSnapshot ordering with `isCheckout` on Meta) are taken from upstream rrweb, not read from the fork.
- `0x78 0x9C` was verified by running fflate's `Zlib` (local fflate 0.4.9, same `zlh` header code: level 6 → FLEVEL 2); not re-run on 0.8.3.
- Absence of `trace` (DSC) in replay envelope headers is inferred from code order, not captured on the wire.

## Observed in the demo (2026-11-10)

From the sentrytap captures (fixtures in [fixtures/](fixtures/index.md), details in [wire-capture.md](wire-capture.md) section 3.10):

- Compression confirmed on the wire: every `replay_recording` payload was `{"segment_id":N}\n` + a zlib stream starting `78 9c`, including segment 0. The `options` event still said `"useCompression": false`, so that flag does not describe the payload.
- Session-mode segment 0 arrived 5.1 s after init (flush min delay); later segments about 5 s after activity.
- Buffer mode: the error and segment 0 (`replay_type:"buffer"`, `error_ids` = that error) arrived in the same second; segment 1 followed 5 s later; `sampled` stayed `"buffer"` in `sentryReplaySession` and later segments kept `replay_type:"buffer"`, also after a reload.
- `replay_event` carries `segment_names` (span names), which the code list above should include.
- Masking: text became `*` with spaces kept; the input value was 16 `*` for 16 characters; element ids are not masked.
- Canvas: no canvas mutation events in a hidden browser pane, although `shouldRecordCanvas: true`. Unverified.
- Self-hosted Sentry listed the three replays with `count_segments` 5, 4 and 3 (API `GET /api/0/projects/sentry/step6-browser/replays/<id>/`).
- Timestamp units observed: rrweb events, `options` and most breadcrumbs carry a top-level `timestamp` in ms; all `performanceSpan` events and the `ui.focus` breadcrumbs in float seconds (census in [wire-capture.md](wire-capture.md) section 3.10).
