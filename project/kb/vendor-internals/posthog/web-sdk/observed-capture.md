# PostHog web SDK: what our capture saw, and bundle sizes

- **SDK:** `posthog-js@1.447.6` from npm, dist files served locally (no CDN).
- **Harness:** [examples/posthog-capture](../../../../../examples/posthog-capture/README.md). A Node capture server on 127.0.0.1:4570 mocks remote config and `/flags`. Headless Chrome 157 is driven over DevTools with real mouse and key input. The page is served as `posthog-capture.localhost`, because the replay network plugin is off on the exact hosts `localhost` and `127.0.0.1` (pj:browser-common/src/utils/request-utils.ts L7, L156-158).
- **Date:** 2026-11-10. Fixtures: [../wire-format/fixtures/](../wire-format/fixtures/).

## 1. One scripted session: what was sent

The driver clicks a button, rage-clicks (4 clicks, 100 ms apart), clicks a non-interactive span, types into a text input, a password input and a `data-ph-capture-value` input, and submits a form. It then calls `fetch` (200 and 500), `console.log/warn/error`, throws a TypeError, makes an unhandled rejection, runs `capture` + `identify` + `captureException`, adds 200 `<li>`, calls `pushState`, scrolls, and navigates away.

| # | Request | Content | Raw → decoded bytes |
|---|---|---|---|
| 1 | `GET /array/<token>/config.js` | 404 on purpose | — |
| 2 | `POST /e/` | `$pageview` (before remote config arrived) | 906 → 1,930 |
| 3 | `GET /array/<token>/config` | Remote config JSON (our mock) | — |
| 4 | `GET /static/1.447.6/{surveys,logs,lazy-recorder}.js` | Lazy extensions after config | — |
| 5 | `POST /flags/?v=2` (×2) | Flags. Second call after `identify` | 416 → 1,102 |
| 6 | `POST /i/v0/e/` | `$identify` | 1,421 → 4,161 |
| 7 | `POST /i/v0/e/` | 25 events: `$autocapture` ×21, `$rageclick`, `$$heatmap`, `$web_vitals`, `demo_manual_event` | 4,029 → 74,545 |
| 8 | `POST /s/` | 1 `$snapshot` holding 89 rrweb events, `$snapshot_bytes` 26,662 | 6,943 → 29,014 |
| 9 | `POST /i/v0/e/` | 4 × `$exception` | 1,830 → 13,399 |
| 10 | `POST /i/v1/logs?token=…` | OTLP/JSON logs (console capture) | 590 → 3,099 |
| 11 | `POST /s/` | 2 `$snapshot` (console, network, mutations, the pushState `$pageview` custom event) | 4,685 → 15,221 |
| 12 | `POST /i/v0/e/` | `$autocapture`, `$pageview` (pushState), `$$heatmap` | 1,737 → 9,606 |
| 13–14 | `POST /i/v0/e/`, `POST /s/` with `sec-fetch-mode: no-cors` | Unload flush via `sendBeacon`: `$$heatmap`, and a last `$snapshot` | 1,235 / 408 |

Replay for this ~20 s session was **12.0 KB on the wire** (gzip) and 45 KB as JSON after HTTP gunzip. The FullSnapshot of the small demo page was 5,768 B of JSON, carried as 1,306 B of gzip inside the event. Analytics events were 9.2 KB on the wire and ~103 KB decoded: autocapture events carry about 3 KB of properties each.

## 2. Observed vs documented

| Topic | Documented / source says | Observed |
|---|---|---|
| Compression flag | rust/capture reads `?compression=gzip-js` or the `Content-Encoding` header | **Neither was sent.** Body is raw gzip with `Content-Type: text/plain` (a CORS-simple request with no preflight) and no `compression` query parameter. The server must sniff the gzip magic bytes. posthog-js drops the param for gzip on purpose (pj:browser/src/request.ts L573-585) |
| Analytics body | `{api_key, batch, sent_at}` | Yes. Each event is `{uuid, event, properties, timestamp}` |
| Replay body | — | **A bare JSON array** of `$snapshot` events, each with its own `sent_at`. No `api_key` envelope: the token is in `properties.token` |
| Per-event replay compression | `compress_events` default true | FullSnapshot `data` and Mutation `adds/removes/texts/attributes` are gzip bytes as latin1 strings, marked `cv: "2024-10"`. Other events are plain JSON. Fixtures `web-s-snapshot-raw.json` (as sent) and `web-s-snapshot-decoded.json` |
| Replay metadata in-band | — | The recorder sends custom events (type 5): `$remote_config_received`, `$session_options` (masking settings), `$posthog_config` (**the whole init config, including the token**), `$recording_started`, and `$pageview` on navigation |
| Network capture | Off on localhost | On for `*.localhost`. One `rrweb/network@1` event per batch holds PerformanceEntry timing plus `method`, `status`, `requestHeaders`, `responseHeaders` and bodies, when enabled. The navigation entry is included |
| Console in replay | `consoleLogRecordingEnabled` | `rrweb/console@1` events, plus a separate OTLP log stream to `/i/v1/logs` |
| Input masking | `maskAllInputs: true` | Text and password values were never sent, in replay or autocapture. The `data-ph-capture-value` field's value **was** sent in `$autocapture` as `$input_value: "visible-value"` |
| Exceptions | `$exception_list[]` with mechanism | 4 events. console.error → `mechanism.type: "onconsole"`, `synthetic: true`. Thrown and rejected → `handled: false`. Manual → `handled: true`. Frames: `platform: "web:javascript"`, `in_app` set. No `$exception_fingerprint` client-side (computed server-side) |
| Web vitals | CLS, FCP, INP, LCP | One `$web_vitals` with FCP and LCP (232 ms each). LCP attribution included `timeToFirstByte`. CLS and INP did not fire in the 20 s session (no layout shift; INP reported later or not at all in headless) |
| Dead clicks | Lazy extension, 2.5 s mutation window | **No `$dead_click` observed** for the span click (the extension loaded). Unverified why: possibly the threshold timing or the cursor:pointer span. Not chased further |
| `$pageleave` | On pagehide | **Not received** when the driver navigated with `Page.navigate(about:blank)`, although the queue was flushed by sendBeacon at that moment. A synthetic `dispatchEvent(new PageTransitionEvent('pagehide'))` did produce `$pageleave` together with a pending `$web_vitals`. Treat as unverified in real browsers |
| Bots | `opt_out_useragent_filter: false` drops bots | HeadlessChrome UA → **zero events** sent (only flags and logs) |
| Session and window ids | UUIDv7 | `$session_id` and `$window_id` (per tab, in sessionStorage) on every event. Replay events carry the same ids |

## 3. Event property bloat (relevant for cost)

The first `$autocapture` had 74 properties, including SDK debug ones: `$sdk_debug_replay_*`, `$sdk_debug_retry_queue_size`, `$lib_rate_limit_remaining_tokens`, `$debug_first_full_snapshot_timestamp`, `$web_vitals_enabled_server_side`, `$exception_capture_enabled_server_side`, `$dead_clicks_enabled_server_side`, `$configured_session_timeout_ms`. Feature flags travel on every event as `$active_feature_flags` and `$feature/<key>`. Session entry props travel too: `$session_entry_url`, `$session_entry_referrer`, and so on. See fixture `web-i-v0-e-batch.json`.

## 4. Bundle sizes (measured)

Measured with `gzip -9` on the npm tarball `posthog-js-1.447.6.tgz`, `dist/` files, 2026-11-10. Brotli was not available on the machine. CPU and memory overhead are Step 5's job.

| File | Role | Raw | gzip -9 |
|---|---|---|---|
| `array.js` | CDN snippet core (lazy extensions) | 375,556 | **120,538** |
| `module.js` | npm ESM core | 379,208 | 122,001 |
| `module.slim.js` | Slim core (no autocapture extras) | 158,513 | 53,317 |
| `array.full.js` | Core plus all extensions bundled | 725,847 | 224,367 |
| `module.full.no-external.js` | Everything bundled, no runtime loading | 797,944 | 233,132 |
| `lazy-recorder.js` | Replay: rrweb plus PostHog recorder (what the SDK loaded) | 221,107 | **68,750** |
| `recorder.js` / `recorder-v2.js` | Legacy recorder entry points | 140,600 | 42,973 |
| `rrweb.js` | rrweb alone | 333,822 | 99,477 |
| `exception-autocapture.js` | Error autocapture | 17,831 | 6,521 |
| `web-vitals-with-attribution.js` | Web vitals plus attribution | 27,027 | 7,019 |
| `web-vitals.js` | Web vitals | 11,042 | 3,955 |
| `dead-clicks-autocapture.js` | Dead clicks | 24,047 | 8,534 |
| `logs.js` | OTLP logs | 7,206 | 2,764 |
| `tracing-headers.js` | Tracing headers patch | 4,713 | 1,975 |
| `surveys.js` | Surveys (loaded by default) | 143,949 | 47,679 |

**Total loaded in our demo:** 120.5 + 68.8 + 47.7 + 8.5 + 7.0 + 6.5 + 2.8 ≈ **262 KB gzip** across 7 script requests. Without surveys (`disable_surveys: true`) it is ≈ 214 KB.
