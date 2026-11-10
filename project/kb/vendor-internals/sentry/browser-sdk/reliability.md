# Sentry browser SDK: delivery reliability (page hide, keepalive, buffers, retries, offline, rate limits)

- Package: `@sentry/browser` **11.11.0** (tag 2026-11-05). Compared with **10.78.0**.
- Research date: 2026-11-10.
- `B` = https://github.com/getsentry/sentry-javascript/blob/11.11.0 . `B10` = the same path at tag `10.78.0`.
- Every claim is marked **(code)** or **(docs, accessed 2026-11-10)**. "Inference" marks a conclusion drawn from code that was not run.
- Siblings: [architecture.md](architecture.md), [sampling.md](sampling.md), [configuration.md](configuration.md), [wire-capture.md](wire-capture.md), [replay-browser.md](replay-browser.md).

## Why this matters for ouo

Data that never leaves the tab cannot be seen by any collector. We need to know which loss is reported (client reports) and which is silent, so that ouo's "session health" numbers are not built on missing data.

## 1. Page hide: who listens

| Listener | Event | Action | Where |
|---|---|---|---|
| `BrowserClient` | `visibilitychange` → `hidden` | `_flushOutcomes()` (client reports), then in a microtask `client.flush()` | B/packages/browser/src/client.ts#L165-L187 (code) |
| `BrowserClient` | `freeze`, `resume`, `pagehide`, `pageshow`, `visibilitychange` | `timestampInSeconds()` to correct clock drift after sleep or bfcache | B/packages/browser/src/client.ts#L153-L195 (code) |
| `client.flush()` | emits `flush` | drains log buffer, metric buffer, streamed span buffer; waits for the transport buffer | B/packages/core/src/client.ts#L495-L511, #L181-L183; B/packages/core/src/tracing/spans/spanBuffer.ts#L86-L88 (code) |
| `browserTracingIntegration` | `pagehide` | ends the active pageload/navigation idle span with `sentry.idle_span_finish_reason = 'documentHidden'`, then `client.flush()` | B/packages/browser/src/tracing/browserTracingIntegration.ts#L594-L609 (code) |
| `registerBackgroundTabDetection` (`markBackgroundSpan`, default true) | `visibilitychange` → hidden | ends the active root span; sets status `cancelled` if it was `ok`; sets `sentry.cancellation_reason = 'document.hidden'` | B/packages/browser/src/tracing/backgroundtab.ts#L10-L45; browserTracingIntegration.ts#L282, #L736-L738 (code) |
| Web vitals | `visibilitychange` → hidden (`onHidden`) | collects the pageload LCP/CLS once (or at the first navigation) | B/packages/browser-utils/src/web-vitals/reportEvents.ts#L16-L44; B/packages/browser-utils/src/web-vitals/utils.ts#L71-L79 (code) |
| `browserSessionIntegration` | `whenIdleOrHidden` | sends the initial session at idle (`requestIdleCallback`, else `setTimeout`) or at the first hide, whichever is first | B/packages/browser/src/integrations/browsersession.ts#L41-L57; B/packages/browser-utils/src/web-vitals/utils.ts#L164-L189 (code) |
| Replay | `visibilitychange` (hidden), `blur` | `_doChangeToBackgroundTasks` → `conditionalFlush()` (session mode only) | B/packages/replay-internal/src/replay.ts#L245-L264, #L968-L973, #L1018-L1043, #L705-L711 (code) |

Order matters. The client's `visibilitychange` listener is registered first. It defers `flush()` to a microtask so that background-tab detection can end the segment span first, so the segment is flushed with its children. Because that ordering is fragile, tracing also listens to `pagehide` and does end + flush itself. (code, B/packages/browser/src/client.ts#L177-L184; browserTracingIntegration.ts#L594-L601)

Not on page hide:
- Client reports are sent **only** on hide. There is no interval. `flush()` and `close()` do not send them. (code, B/packages/browser/src/client.ts#L173-L176; B/packages/core/src/client.ts#L495-L528)
- There is no `beforeunload` or `unload` listener in browser, browser-utils, core or replay. (code, grep at the tag)
- `navigator.sendBeacon` is not used anywhere. Everything rides on `fetch` with `keepalive`. (code, grep at the tag)

## 2. `keepalive` and the 64 KiB budget

(code, B/packages/browser/src/transports/fetch.ts#L16-L61)

- `keepalive: pendingBodySize <= 60_000 && pendingCount < 15`.
- Both counters include the request being built and are decremented when the fetch settles.
- So in a burst at page hide (client report, logs, metrics, spans, replay segment), the first envelopes get `keepalive` and later ones do not, once 60,000 is exceeded or 15 requests are open.
- Requests without `keepalive` may be cancelled when the document unloads. The SDK records that as `network_error` only if the JS still runs to see the rejection. (inference from code, #L29-L32 comment and base.ts#L107-L111)
- The size check uses `body.length`: UTF-16 code units for strings, bytes for `Uint8Array`. (code, #L20)
- Firefox does not support `keepalive` per the code comment. (code comment, #L34)
- `fetchOptions` can override `keepalive`. (code, #L41)

## 3. Buffers and what is dropped

| Buffer | Limit | When full | Where |
|---|---|---|---|
| Client processing buffer (errors, transactions) | 64 (`transportOptions.bufferSize`) | `queue_overflow:<category>` | B/packages/core/src/client.ts#L274, #L1688-L1706 (code) |
| Browser transport buffer (HTTP in flight) | 40 (`transportOptions.bufferSize`) | `queue_overflow` per item (and `span` for transactions) | B/packages/browser/src/transports/fetch.ts#L7, #L67; B/packages/core/src/transports/base.ts#L114-L125 (code) |
| Log buffer | 100 logs, ~800 KB estimated weight, 5 s timer | flushes, does not drop | B/packages/core/src/logs/internal.ts#L32, #L62-L74; B/packages/core/src/client.ts#L69, #L132-L184 (code) |
| Metric buffer | 1000 metrics, ~800 KB, 5 s | flushes | B/packages/core/src/metrics/internal.ts#L29, #L59-L70 (code) |
| Streamed span buffer | per trace: 1000 spans, 5,000,000 bytes, 5 s timer; plus flush 500 ms after a segment ends | flushes | B/packages/core/src/tracing/spans/spanBuffer.ts#L15-L17, #L76-L125; B/packages/core/src/integrations/spanStreaming.ts#L51-L62 (code) |
| Breadcrumbs | 100 (`maxBreadcrumbs`) | oldest dropped, silently | B/packages/core/src/scope.ts#L567-L590 (code) |
| Replay event buffer | 20,000,000 bytes | `buffer_overflow:replay`; buffer mode clears and waits for the next checkout; session mode stops replay | B/packages/replay-internal/src/constants.ts#L44; B/packages/replay-internal/src/util/addEvent.ts#L93-L114 (code) |
| Offline queue (IndexedDB) | 30 envelopes | new envelope silently not stored | B/packages/browser/src/transports/offline.ts#L51-L62, #L131 (code) |

The promise buffer is a `Set` of in-flight promises; there is no waiting queue. A task that does not fit is rejected at once. (code, B/packages/core/src/utils/promisebuffer.ts#L45-L58)

## 4. Retries

| Path | Retry? | Where |
|---|---|---|
| Base transport (`createTransport`) | **No.** Network error → `network_error`, rethrow. Non-2xx → returned as is. | B/packages/core/src/transports/base.ts#L80-L112 (code) |
| `makeFetchTransport` | No. Only clears the cached native fetch on error. | B/packages/browser/src/transports/fetch.ts#L55-L57 (code) |
| Replay | Yes: 3 retries at 5 s, 10 s, 30 s for thrown errors; none for non-2xx or rate limits | B/packages/replay-internal/src/util/sendReplay.ts#L10-L70; constants.ts#L29-L30 (code) |
| Offline transport | Yes, opt-in (section 5) | B/packages/core/src/transports/offline.ts (code) |

## 5. `makeBrowserOfflineTransport`

`makeBrowserOfflineTransport(createTransport = makeFetchTransport)` wraps the fetch transport with `makeOfflineTransport` and an IndexedDB store. (code, B/packages/browser/src/transports/offline.ts#L176-L180)

| Setting | Default | Where |
|---|---|---|
| IndexedDB database | `'sentry-offline'` (`dbName`) | offline.ts#L121 (code) |
| Object store | `'queue'` (`storeName`) | offline.ts#L121 (code) |
| `maxQueueSize` | 30 | offline.ts#L131, #L139 (code) |
| `MIN_DELAY` | 100 ms | B/packages/core/src/transports/offline.ts#L11 (code) |
| `START_DELAY` | 5,000 ms | #L12 (code) |
| `MAX_DELAY` | 3,600,000 ms (1 h) | #L13 (code) |
| `flushAtStartup` | off; if on, schedules a flush after `START_DELAY` | #L192-L194 (code) |
| `shouldStore(env, error, retryDelay)` | store everything except client reports | #L85-L96 (code) |
| `shouldSend(env)` | optional; `false` throws and leads to storage | #L143-L152 (code) |

Send logic (code, B/packages/core/src/transports/offline.ts#L133-L190):
1. Any envelope with `replay_event` or `replay_recording` is **always** pushed to the store first, then flushed after 100 ms. This keeps replay segments in order.
2. Otherwise send through the wrapped transport.
3. Success path:
   - `retry-after` header → next queue flush after that delay.
   - else `x-sentry-rate-limits` header → next flush after 60 s.
   - else status `>= 400` → return, do not drain the queue.
   - else drain the next queued envelope after 100 ms, and reset backoff to 5 s.
4. Thrown error (network failure, `shouldSend` false) → if `shouldStore` allows, push (or `unshift` if it was a retry) and back off: 5 s, then doubling, max 1 h.

What counts as retryable: **only thrown errors**. HTTP errors (4xx, 5xx, 429) do not throw in the base transport, so they are never stored. (code, base.ts#L82-L106 with offline.ts#L154-L172)

Rate limits with offline: items already under a rate limit are dropped by the base transport with `ratelimit_backoff` and resolve `{}`. The offline wrapper sees a success and does not store them. (inference from code, base.ts#L52-L64)

Triggers to drain: `online` window event → `transport.flush()`; `client.flush()` without timeout (it runs on every page hide) → flush after 100 ms. (code, B/packages/browser/src/transports/offline.ts#L165-L167; B/packages/core/src/transports/offline.ts#L198-L206) On retry, `sent_at` is set to now. (code, #L113)

Store errors are swallowed; a full queue drops silently. (code, B/packages/browser/src/transports/offline.ts#L51-L62, #L128-L155)

## 6. Rate limits

### 6.1 Parsing

`updateRateLimits(limits, {statusCode, headers})` (code, B/packages/core/src/utils/ratelimit.ts#L53-L108):

1. If `X-Sentry-Rate-Limits` is present, for each comma-separated entry `retry_after:categories:scope:reason_code:namespaces`:
   - `retry_after` seconds (non-number → 60).
   - Empty `categories` → key `all`.
   - Else each `;`-separated category gets `now + delay`.
   - `metric_bucket` only applies if `namespaces` is empty or contains `custom`.
   - `scope` and `reason_code` are ignored.
2. Else if `Retry-After` is present → `all` = now + parsed delay (seconds, or HTTP date, else 60 s). (#L16-L28)
3. Else if status is 429 → `all` = now + 60 s.

`isRateLimited(limits, category)` is true when `limits[category] || limits.all` is in the future. (code, #L37-L46)

The rate limits object is per transport instance, in memory. A reload clears it. (code, B/packages/core/src/transports/base.ts#L37)

### 6.2 Category mapping

Item types map to categories with `envelopeItemTypeToDataCategory`: `event→error`, `transaction→transaction`, `session`/`sessions→session`, `attachment→attachment`, `replay_event`/`replay_recording→replay`, `profile`/`profile_chunk→profile`, `log→log_item`, `metric→trace_metric`, `trace_metric→trace_metric`, `feedback→feedback`, `span→span`, `client_report→internal`, `check_in→monitor`, `raw_security→security`, `user_report→default`. (code, B/packages/core/src/utils/envelope.ts#L196-L222)

So a server limit on `log_item` or `trace_metric` drops those envelopes on the client before any request. A `span` limit drops streamed span envelopes. A `transaction` limit does not drop streamed spans. (inference from code)

## 7. From loss to client report

| Reason | Trigger | Where |
|---|---|---|
| `ratelimit_backoff` | item category under an active limit | B/packages/core/src/transports/base.ts#L53-L56 (code) |
| `network_error` | fetch threw | base.ts#L107-L108 (code) |
| `send_error` | HTTP 413 | base.ts#L86-L92 (code) |
| `queue_overflow` | transport buffer full, client buffer full | base.ts#L117-L119; client.ts#L1699-L1701 (code) |
| `before_send` | `beforeSend*` returned `null` | client.ts#L1617-L1621 (code) |
| `callback_error` | user callback threw | client.ts#L1789-L1868 (code) |
| `event_processor` | processor returned `null` | prepareEvent.ts#L118-L127 (code) |
| `sample_rate` | error or trace sampling | client.ts#L1582, #L1638; trace.ts#L527-L538 (code) |
| `ignored`, `no_parent_span` | `ignoreSpans`, `onlyIfParent` | trace.ts#L310, #L369 (code) |
| `buffer_overflow`, `internal_sdk_error` | replay event buffer | replay-internal/src/util/addEvent.ts#L100-L101 (code) |
| `invalid`, `send_error`, `ratelimit_backoff` (replay) | replay `_runFlush` failure | replay-internal/src/replay.ts#L1252-L1264 (code) |

For each item the base transport records the item category, and for a transaction also `1 + spans` on `span`. Container items (`span`, `log`) record `item_count`. (code, base.ts#L40-L47)

**Silent losses** (no client report):
- Client reports themselves (never self-reported, never offline-stored). (code, base.ts#L69-L74; offline.ts#L87-L89)
- Outcomes in memory when a tab is closed without a `hidden` event, or when the hide-time client report request is cancelled.
- `keepalive`-less requests cancelled after JS stops.
- Breadcrumbs beyond the limit, `beforeBreadcrumb` drops.
- Sessions without a release.
- Offline queue overflow and IndexedDB errors.
- Replay sampling decisions.

## 8. Replay reliability

Constants (code, B/packages/replay-internal/src/constants.ts#L15-L56):

| Constant | Value |
|---|---|
| `SESSION_IDLE_PAUSE_DURATION` | 300,000 ms (5 min) |
| `SESSION_IDLE_EXPIRE_DURATION` | 900,000 ms (15 min) |
| `DEFAULT_FLUSH_MIN_DELAY` / `MAX_DELAY` | 5,000 / 5,500 ms |
| `BUFFER_CHECKOUT_TIME` | 60,000 ms (buffer mode keeps about the last minute) |
| `RETRY_BASE_INTERVAL` / `RETRY_MAX_COUNT` | 5,000 ms / 3 |
| `REPLAY_MAX_EVENT_BUFFER_SIZE` | 20,000,000 bytes |
| `MIN_REPLAY_DURATION` | 4,999 ms (cap 50,000) |
| `MAX_REPLAY_DURATION` | 3,600,000 ms (60 min); user value is capped to it (integration.ts#L201) |

Session lifecycle:
- The session is stored in `sessionStorage` key `sentryReplaySession`, so a reload in the same tab continues the same replay id and segment counter. (code, constants.ts#L9; session/saveSession.ts#L8-L19)
- Expired when `started` is older than `maxReplayDuration` or `lastActivity` is older than 15 min. A buffer session that never flushed (`segmentId === 0`) is kept. (code, util/isSessionExpired.ts#L7-L21; session/shouldRefreshSession.ts#L5-L20)
- On hide with an expired session, `replay_id` is removed from the DSC and nothing is flushed. (code, replay.ts#L1018-L1031)

Flush rules (code, replay.ts#L1184-L1340):
- Not sent if shorter than `minReplayDuration` (reschedules) or longer than `maxReplayDuration + 5 s`.
- At send time, if more than `maxReplayDuration + 30 s` passed since the segment start → `ReplayDurationLimitError` → `invalid:replay`, stop.
- `segmentId` is incremented and the buffer emptied **before** the send result is known.

Send and stop (code, B/packages/replay-internal/src/util/sendReplayRequest.ts#L101-L131; sendReplay.ts#L24-L70; replay.ts#L1239-L1265):
- A thrown transport error → retry up to 3 times (5 s, 10 s, 30 s), then `send_error:replay` and stop.
- After a response, rate limits are computed from **that** response only. If `replay` is limited (429, `X-Sentry-Rate-Limits` with `replay` or all, or `Retry-After`) → `RateLimitError` → `ratelimit_backoff:replay` and **replay stops** (`reason: 'sendError'`). It does not resume in this session.
- Non-2xx → `TransportStatusCodeError` → `send_error:replay`, stop, no retry.
- If the base transport already dropped the item for an earlier rate limit, it returns `{}` without a status. Replay treats that as success and keeps recording; the base transport records `ratelimit_backoff`. (inference from code, sendReplayRequest.ts#L120-L131 with base.ts#L62-L64)

Tab close mid-segment:
- In `session` mode, hide triggers `flushImmediate()`. The flush path is async (performance entries, memory entry, compression worker `finish()`), then `transport.send`. (code, replay.ts#L705-L729, #L1184-L1235)
- If the page is killed before that chain reaches `fetch`, the pending events are lost. If the segment body pushes the in-flight total over 60,000, it goes without `keepalive` and may be cancelled. (inference from code)
- In `buffer` mode nothing is sent on hide. The buffered minute is lost unless an error converted it before. (code, replay.ts#L705-L708)
- Because the session id lives in `sessionStorage`, a same-tab reload continues the replay; the lost events show as a gap. (inference from code)

Replay through the offline transport is always queued in IndexedDB first, so it survives offline periods in order. (code, B/packages/core/src/transports/offline.ts#L134-L140)

## 9. Practical notes for ouo

- A collector that receives Sentry envelopes sees **no** client reports from a tab that never became hidden. Treat missing client reports as "unknown", not "zero loss". (inference)
- Expect bursts at `visibilitychange`: client report, then logs, metrics and span envelopes, plus a replay segment. Size the receiver for that burst. (inference from section 1)
- Our ingest must answer with `X-Sentry-Rate-Limits` (or 429 / `Retry-After`) to slow the SDK; any other status is ignored by the SDK except 413. (code, section 6)

## Differences vs 10.78.0

| Area | 10.78.0 | 11.11.0 | Source |
|---|---|---|---|
| Page listeners | client: `visibilitychange` only | client also listens to `freeze`, `resume`, `pagehide`, `pageshow` (clock drift); tracing ends the idle span and flushes on `pagehide` | B/packages/browser/src/client.ts#L153-L200; browserTracingIntegration.ts#L594-L609 (code); no `pagehide` in B10 browserTracingIntegration.ts (code, grep) |
| Background tab | status `cancelled` only when no status set | only when status is `ok` | B10/packages/browser/src/tracing/backgroundtab.ts#L30; B/.../backgroundtab.ts#L34 (code) |
| Session lifecycle default | `'route'` (new session per navigation) | `'page'` | B/packages/browser/src/integrations/browsersession.ts#L26 (code); B/MIGRATION.md#L569-L579 (docs) |
| Transport outcomes | one outcome per item | adds `span` outcomes for transactions and honors `item_count` | B/packages/core/src/transports/base.ts#L40-L47 (code) |
| Offline transport | always `await`s `shouldSend` / `shouldStore` | awaits only when they return a Promise (no extra microtask tick when backgrounded) | B/packages/core/src/transports/offline.ts#L143-L176 (code) |
| Drop reasons | no `callback_error` | `callback_error` added | B/packages/core/src/types/clientreport.ts#L5 (code) |
| Log / metric flushers | wired only if `enableLogs` / `enableMetrics` | always wired | B/packages/core/src/client.ts#L316-L327 (code) |
| Replay event-processor drop | `event_processor:replay` recorded twice (prepareEvent and sendReplayRequest) | recorded once | B10/packages/replay-internal/src/util/sendReplayRequest.ts#L56; B/.../sendReplayRequest.ts#L55-L58 (code) |

Byte-identical between the tags: `utils/ratelimit.ts`, `utils/promisebuffer.ts`, `browser/src/transports/fetch.ts` logic (only a type cast changed), replay `constants.ts`, `util/sendReplay.ts`. (code, `diff`)

## Observed in the demo (2026-11-10)

Captured with sentrytap between `@sentry/react` 11.11.0 in Chromium 152 and self-hosted Sentry 26.10.0; details and fixtures in [wire-capture.md](wire-capture.md) section 4.

| Code claim above | Observed |
|---|---|
| Client reports only on hide | Yes. `Sentry.flush()` sent logs and metrics but no client report. A report arrived on simulated `visibilitychange` and right after a same-tab navigation (the old page's report). |
| Base transport does not retry | Yes for errors and sessions: the CORS-blocked 429 run sent each error once. |
| Replay retries thrown transport errors at 5 s, 10 s | Yes: segment 5 was sent at +0 s, +5 s, +15 s when the response was unreadable (CORS), then a client report counted `network_error:replay`. |
| Rate limits apply per category | Yes: with `60:error;transaction;span;replay:organization`, errors, spans and replay stopped; sessions, profile chunks, logs and trace metrics continued. |
| Replay keeps recording when the base transport drops it | Yes: `getReplay()` stayed enabled and `segmentId` in `sessionStorage` kept growing while the client report counted `ratelimit_backoff:replay` 4. |
| Offline transport | IndexedDB `sentry-offline` / store `queue`; six envelopes stored while the endpoint was down (one re-queued with key `-1`); all sent within 1 s of the next page start with `flushAtStartup: true`. |
| Tab close mid-segment loses replay data | Yes: closing 300 ms after input lost that replay segment; the error, session update and span container from the same moment arrived. |
| A receiver must expose rate-limit headers through CORS | Yes: without `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers`, the SDK ignored the 429 entirely and reported `network_error`. |
