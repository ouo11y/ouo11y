# Sentry bridge specification

Status: implemented (`collector/receiver/ouosentryreceiver`, rum-api video kind, plugin 0.4.0) and verified on real `@sentry/react-native` 8.30.0 / `sentry-cocoa` 9.30.1 traffic on 2026-10-14 (`project/reports/sentry-bridge-verification.html`). Normative since ADR-0008 was accepted on 2026-10-17. Bridge parity fixes A1 to A3, A5 to A9, A11, C5 and the N2 findings (checklist section 2) were added on 2026-10-23 and verified against self-hosted Sentry 26.10. The former **(verify)** items are resolved below from the captures in `collector/receiver/ouosentryreceiver/testdata/golden/`; Android payloads are still unverified.

Scope: envelopes from the Sentry mobile SDKs, `sentry.cocoa` (iOS), `sentry.java.android` (Android) and `sentry.javascript.react-native` (React Native over both). Mobile vitals from transaction `measurements` follow `docs/specs/mobile-vitals.md` (section 6).

**Supported SDK range** (checklist N3, golden journeys per version, details in [compatibility.md](../compatibility.md#sentry-sdks-through-the-bridge)): `@sentry/react-native` 8.x on iOS, captured 8.30.0 (sentry-cocoa 9.30.1) and 8.32.0 (9.31.0), fully supported. 7.11.0 (sentry-cocoa 8.58.0, the Expo SDK 57 default) is partial: under Expo 57 it traces no `fetch`, sends no app start, a TTID in days and transactions stamped hours in the past; sessions, errors, crashes, replay and logs translate. Native sentry-cocoa and sentry-java apps: medium term, not captured.

## 1. Endpoint

```
POST /api/{sentry_project_id}/envelope/        port 4320 (ouosentry receiver in ouo-collector)
*    /api/{sentry_project_id}/{endpoint}/       store, minidump, security, ...: forwarded only (section 2a)
```

- Auth, in this order, and all present ones must agree: `X-Sentry-Auth: Sentry sentry_key=<public key>, ...`, query `?sentry_key=<public key>`, envelope header `dsn`. The pair `(sentry_project_id, public key)` must exist in the project table, else the request goes to `passthrough_upstream` when it is set (section 2a), or is answered `403 {"detail":"unknown project or public key"}` and not forwarded.
- Body: `Content-Encoding` `gzip`, `deflate` or none is translated. Any other encoding (for example `br`) is forwarded but not translated, and counted with reason `encoding`.
- Body limit: `max_request_body_size` (default 100 MiB), `413` above it, not forwarded. Bodies above `max_translate_bytes` (default 20 MiB) are forwarded but not translated.
- CORS: none. Mobile SDKs send no `Origin` (verified); the receiver adds no CORS headers, so browsers cannot use it, which is fine while the browser SDK is out of scope.
- Observed on iOS: every request is `Content-Encoding: gzip`, `Content-Type: application/x-sentry-envelope`, auth in `X-Sentry-Auth` only (no query key, no envelope `dsn`).
- `ouoratelimit` applies per ouo project and client address to the **translated** side only. Upstream Sentry enforces its own limits on the forwarded side.

## 2. Forwarding

For a known project with an upstream:

1. Send `POST {upstream}/api/{sentry_project_id}/envelope/` with the original query string, the original body bytes, and every request header except the hop-by-hop ones (so `Content-Type`, `Content-Encoding`, `X-Sentry-Auth`, `User-Agent` and the rest). `X-Forwarded-For` gets the client address appended (Sentry derives the user's IP from it). Timeout `upstream_timeout` (default 30 s), pooled client, HTTP/2 when offered.
2. Copy the upstream status, every response header except the hop-by-hop ones (`Connection`, `Keep-Alive`, `Proxy-Connection`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`), and the body to the response. That includes `Content-Type`, `X-Sentry-Rate-Limits` and `Retry-After`, and also whatever else Sentry sends (observed with self-hosted Sentry 26.10: its CORS headers and `Server: nginx`), so the SDK sees Sentry's answer unchanged.
3. Upstream timeout or connection error: the receiver **aborts the client connection** instead of answering, and does not translate. The SDK then sees exactly what it sees when Sentry is down: a network error, so it keeps the envelope and retries (a `5xx` answer could make an SDK discard it). Verified on iOS: during an outage sentry-cocoa retried with backoff and flushed every cached envelope once Sentry was back; ouo recorded each event once.
4. Upstream `2xx`: enqueue the decoded envelope for translation. Queue size `translate_queue_size` (default 10 000 envelopes). When full, drop and count with reason `queue_full`.
5. Upstream non-`2xx`: not translated.

With `upstream: none` the receiver answers `200 {"id":"<envelope event_id or empty>"}` and enqueues.

Steps 1 and 2 add the time of one upstream round trip, plus reading the whole body first (store and forward: the body must be complete before it is forwarded unchanged and translated). The translation queue is also bounded in bytes, `translate_queue_bytes` (default 256 MiB, reason `queue_bytes`). A translator panic drops that envelope (reason `panic`); forwarding is not affected.

## 2a. Passthrough and other ingest endpoints ([ADR-0028](../adr/0028-sentry-bridge-mirrors-and-passthrough.md))

`passthrough_upstream` (optional, an http(s) base URL, normally the production Sentry ingest host): every request the bridge does not serve itself goes there unchanged, as in section 2 steps 1 to 3, and is neither translated nor mirrored; counted `outcome = passthrough`. That covers an unknown or missing public key, an unknown project id, every other ingest endpoint (`/api/{id}/store/`, `minidump`, `security`, `unreal`, any method) of an unknown project or of an `upstream: none` project (production keeps getting what the bridge does not translate), any path outside `/api/{id}/{endpoint}/` (for example `/api/{id}/integration/otlp/v1/traces`), and a method other than `POST` on `/envelope/`. Other ingest endpoints of a project with an upstream go to that upstream the same way (key from `X-Sentry-Auth` or the `sentry_key` query). Without `passthrough_upstream` the answers stay `403` (envelope), `404` (other endpoints and paths) and `405` (non-`POST` envelope). With it, the bridge answers nothing itself except a body over `max_request_body_size` (`413`), so it is never the reason an SDK deletes an envelope. Sentry SDKs delete an envelope on a `4xx` other than `429`, so a bridge in front of production should set it.

A bridge fed by a proxy `mirror` (the hybrid deployment of `docs/sentry-bridge-deployment.md`: the proxy has already sent the original to production) must leave `passthrough_upstream` unset: with it, every mirrored envelope the table does not match (another project's DSN on the same ingest host, a rotated key) goes to production a second time (measured 2026-11-17: 120 envelopes in, 180 at production). The receiver cannot tell a mirror-fed bridge from a bridge at the edge with `upstream: none`, where passthrough is what keeps unknown DSNs alive, so the configuration does not reject the combination.

## 2b. Mirrors ([ADR-0028](../adr/0028-sentry-bridge-mirrors-and-passthrough.md))

A project row may list `mirrors`, secondary Sentry upstreams that get a copy of the project's envelopes:

```yaml
mirrors:
  - name: preview                         # metric label, default the upstream host
    upstream: https://sentry-preview.example.com
    sentry_project_id: "7"                # optional: the mirror's own project id
    public_key: "<preview DSN public key>" # optional: the mirror's own key
```

1. When the bridge has answered an envelope (any status from the primary, or `upstream: none`) and flushed that answer to the SDK, it queues one copy per mirror and returns. The primary's answer is the only one the SDK sees; queueing is a non-blocking channel send.
2. Primary unreachable (section 2 step 3): the SDK connection is aborted and no copy is queued; the SDK's retry is mirrored.
3. A copy is the same method, path, query, body bytes and headers as the primary request (hop-by-hop headers removed, the same `X-Forwarded-For`). With `sentry_project_id` or `public_key` set and different, exactly these are rewritten: the project id in the path; the `sentry_key` value in `X-Sentry-Auth`, `Authorization` and the query string, with `sentry_secret` dropped; the envelope header `dsn`, to `<scheme>://<public_key>@<mirror host>[path]/<sentry_project_id>`, only when the envelope has one (a gzip or deflate body is re-encoded the same way, streamed, up to `max_translate_bytes` decoded; `Content-Length` follows). To look for the `dsn` only the envelope header line is decoded, at most 64 KiB. A body without a `dsn` stays byte-identical. A body whose header cannot be read (encoding `br`, a corrupt stream, a header line over 64 KiB, or with a `dsn` and more than `max_translate_bytes` decoded) is sent unchanged, and its send is counted with `reason = body_not_rewritten`.
4. Queues: one per mirror, all mirrors together holding at most `mirror.queue_bytes` (default 256 MiB; each queue also stops at 10 000 envelopes); 4 concurrent sends per mirror, each bounded by `mirror.timeout` (default 10 s), with a connection pool of their own. A copy that does not fit is dropped (`queue_bytes`, `queue_full`); a failed send (`timeout`, `unreachable`) is counted and not retried. Shutdown closes the translate and mirror queues together; a handler still waiting on its upstream then drops its copy and its translation (`reason = shutdown`). The queues drain until the collector's shutdown deadline, then what is in flight is aborted.
5. Metrics: `ouo_sentry_mirror_requests_total{mirror, ouo.project.id, outcome, reason, status_code}`, one count per copy, with outcome `sent` (with the mirror's status), `error` or `dropped`; `ouo_sentry_mirror_duration_seconds{mirror, ouo.project.id}`; `ouo_sentry_queue_bytes{queue = translate | mirror}`.

## 3. Envelope parsing

Per develop.sentry.dev "Envelopes":

- First line: envelope header JSON (`event_id`, `dsn`, `sdk`, `sent_at`, `trace`).
- Then items: a header line JSON with `type` and optional `length`. With `length`, the payload is exactly that many bytes followed by `\n` or end of input. Without `length`, the payload runs to the next `\n` or end of input.
- A malformed envelope is forwarded anyway (upstream decides) and not translated, counted with reason `malformed`.
- Unknown item types are ignored by the translator.

Timestamps in Sentry payloads are either RFC 3339 strings or Unix seconds as a float. Both are accepted. ouo attributes use epoch milliseconds, OTLP uses nanoseconds.

## 4. Resource and common attributes

Every record and span produced from one envelope gets:

| ouo attribute | Source |
|---|---|
| `ouo.project.id` (resource) | project table |
| `service.name` (resource) | project table `service_name` (required; iOS and Android are usually separate Sentry projects and get separate names) |
| `service.version` (resource) | release `<package>@<version>+<build>`: the part after `@` and before `+`. Without `@`, the part before `+` |
| `ouo.app.build` | the part after `+`, when present |
| `ouo.sentry.release` | the raw release |
| `deployment.environment.name` (resource) | `environment` |
| `ouo.platform` | `mobile` |
| `ouo.rum.mode` (resource) | always `sentry`: the rollout cohort recorded by the Sentry SDK (`examples/sentry-mobile/ROLLOUT.md`); the ouo SDK sets `parallel` or `ouo` |
| `os.name`, `os.version` (resource) | `contexts.os.name`, `contexts.os.version`; on log items the entries' `os.name`, `os.version` attributes (section 7a) |
| `device.model.identifier` (resource) | `contexts.device.model`; on log items the `device.model` attribute |
| `telemetry.sdk.name`, `telemetry.sdk.version` (resource) | envelope `sdk.name`, `sdk.version`, else event `sdk` |
| `ouo.sentry.sdk` | `sdk.name` (`sentry.cocoa`, `sentry.java.android`, `sentry.javascript.react-native`) |
| `session.id` | resolved per section 8 |
| `user.id` | event `user.id`, else session `did` |
| `ouo.sentry.session_match` | `envelope`, `replay`, `device` or `none` |

Session attributes are on records and spans, never on the resource, as in the session lifecycle spec.

**Device context from state.** Session updates and replay segments carry no OS or device context. The receiver keeps the last `os.name`, `os.version` and `device.model.identifier` seen on an event, transaction or log entry of each session (and so of each device, `did`). Records and spans of an envelope that lacks them get the values of their session, else of the device's latest started session that has them; values the envelope carries itself win (an `os.name` derived only from the SDK name is replaced). The first `session.start` of a device the receiver has not seen before has none: Sentry sends the session init before any event.

## 5. Sessions (`session` item)

Payload fields used: `sid`, `did`, `init`, `started`, `timestamp`, `status`, `errors`, `duration`, `abnormal_mechanism`, `attrs.release`, `attrs.environment`.

| Sentry update | ouo log record |
|---|---|
| `init: true` | `session.start`, timestamp `started`, `ouo.session.started_at` = `started` in ms, `session.previous_id` |
| `status: ok`, `init: false` | none (keeps the device state fresh, section 8) |
| `status: exited` | `session.end`, `ouo.session.end_reason = background` |
| `status: crashed` | `session.end`, `ouo.session.end_reason = crash` |
| `status: abnormal` | `session.end`, `ouo.session.end_reason = terminated`, `ouo.sentry.abnormal_mechanism` (for example `anr_foreground`) |
| `status: unhandled` | none; the error event in the same envelope carries the exception |

- `session.end` timestamp is the update `timestamp`, except: a `crashed` session ends at its fatal exception (sentry-cocoa reports the crash and the `crashed` update on the next launch), and an `abnormal` update whose `timestamp` equals `started` (killed process, reported on the next launch with duration 0) ends at the last activity the receiver saw for the session. `ouo.session.duration_ms` is `duration * 1000` when present and positive, else end minus `started`.
- Observed on iOS: updates after the first omit `init` (treated as `false`); `exited` is sent when the app returns to the foreground with `timestamp` = the moment it went to the background; after a crash the next session's `init` arrives before the crash event and the `crashed` update; `did` equals the default event `user.id`.
- Every `session.end` also carries `ouo.sentry.session.status` (raw status) and `ouo.sentry.session.errors`.
- `session.previous_id` on `session.start` and `session.end`: the `sid` of the same device's (`did`) latest session that started before this one, when the receiver knows it, as the ouo SDKs set it. After a crash it is the crashed session (its `crashed` update arrives after the new session's init; the session itself is known from earlier envelopes).
- The receiver emits at most one `session.start` and one `session.end` per `sid` while it holds the state. After a restart a duplicate is possible. It is harmless: it comes from the same Sentry update, so it has the same timestamp and reason, and rum-api folding keeps the last `session.end` of a session.
- **Unsampled errors.** Sentry counts every error in `errors` even when the error event itself was sampled out or dropped by `beforeSend`. When an update's `errors` exceeds the number of `exception` records the receiver emitted for that `sid`, it emits the difference as `exception` records with `exception.type = "sentry.unsampled_error"`, `exception.message = ""`, `ouo.exception.fatal = false`, `ouo.exception.handled = true`, `ouo.sentry.synthetic = true`. This keeps ADR-0004 `errored` in line with Sentry.
- `sessions` items (aggregates) come from server SDKs and are not translated.

## 6. Errors (`event` item)

An `event` becomes an `exception` log record when its `level` is `error` or `fatal`, or it has no `level` and has `exception.values`, or it has a level below error (`warning`, `info`, `debug`) and at least one exception value that is not synthetic (`mechanism.synthetic` absent or false). Other events become a `custom` record named `sentry.message` with `ouo.event.custom = true`, `message`, `ouo.sentry.level`, `ouo.sentry.event_id` and the error context below. `Sentry.captureMessage` in React Native (attachStacktrace is on by default) sends `level: info` with one synthetic exception value carrying the message; it is a `sentry.message`, and Sentry does not count it in the session's `errors` either (observed: Sentry 2 errors, the bridge 3 before this rule).

| ouo attribute | Source |
|---|---|
| timestamp | event `timestamp` |
| trace id, span id of the log record | `contexts.trace.trace_id`, `contexts.trace.span_id` |
| `exception.type` | last element of `exception.values` (Sentry orders chained exceptions oldest to newest) `.type`; `Message` for message-only events |
| `exception.message` | that element's `.value`; for message-only events `logentry.formatted`, else `message` |
| `exception.stacktrace` | all values, newest first, each as `Type: value` then one line per frame from the top of the stack: `  at {function} ({module or filename}:{lineno}:{colno})`, `[in app]` suffix when `in_app`. A native frame without file or module (unsymbolicated sentry-cocoa / sentry-java NDK) reads `  at {function or ?} ({image name} {instruction_addr} 0x{image_addr} + {offset})`, the Apple crash report form `atos` takes with the image's dSYM; `{image name} {instruction_addr}` when `image_addr` is 0 or unknown. Values after the first are prefixed `Caused by: `. Capped at 32 KiB |
| `ouo.exception.fatal` | `true` when `level == "fatal"`, or the same envelope holds a `session` update for the resolved `sid` with `status: crashed`. Else `false` |
| `ouo.exception.handled` | last value's `mechanism.handled`, default `true` |
| `ouo.sentry.mechanism` | last value's `mechanism.type` (for example `AppHang`, `ANR`, `signalhandler`, `onerror`) |
| `ouo.sentry.event_id` | envelope or event `event_id` |
| `ouo.sentry.level` | `level` |
| `ouo.sentry.debug_images` | JSON array of the `debug_meta.images` the frames point into (native frames by `image_addr`, JavaScript frames by `filename` = source map `code_file`), at most 64, each `{type, code_file, debug_id, image_addr, image_vmaddr, image_size, arch}` with `code_file` reduced to the image name for native images: what symbolication needs (dSYM by `debug_id`, load address) |

`ouo.sentry.event_id` lets the plugin later link an ouo timeline entry to the same event in Sentry (`<sentry ui>/organizations/<org>/issues/?query=id:<event_id>`), configured per project as `sentry_ui_url`.

The breadcrumbs attached to the event become timeline records as described in section 9b.

### 6a. Error context

`exception` and `sentry.message` records carry this allowlist (A6); nothing else from `contexts` is copied:

| ouo attribute | Source |
|---|---|
| `ouo.device.locale` | `contexts.device.locale`, else `contexts.culture.locale` |
| `network.connection.type` | `contexts.device.connection_type`: `wifi`, `cellular` → `cell`, `wired` / `ethernet` → `wired`, `none` / `offline` → `unavailable`, others as sent (sentry-cocoa's crash reports have none) |
| `ouo.device.thermal_state`, `ouo.device.orientation` | `contexts.device.thermal_state`, `.orientation` |
| `ouo.device.free_memory`, `ouo.device.memory_size` | `contexts.device.free_memory`, `.memory_size` (bytes) |
| `ouo.device.low_power_mode`, `ouo.device.charging`, `ouo.device.simulator` | `contexts.device.low_power_mode`, `.charging`, `.simulator` |
| `ouo.device.battery_level` | `contexts.device.battery_level` (percent) |
| `ouo.app.screen` | last element of `contexts.app.view_names` (the current screen) |
| `ouo.app.in_foreground` | `contexts.app.in_foreground` |
| `ouo.app.start_time` | `contexts.app.app_start_time`, epoch ms |
| `ouo.app.memory` | `contexts.app.app_memory` (bytes) |
| `ouo.sentry.tag.<key>` | `tags`, only with the project option `copy_tags: true` (app-chosen content, off by default), at most 32 keys in key order, values truncated to 1 KiB |

## 7. Transactions (`transaction` item)

Each transaction becomes one root span plus one span per element of `spans`.

| OTel span field | Root (the transaction) | Child (`spans[]`) |
|---|---|---|
| trace id | `contexts.trace.trace_id` | `trace_id` |
| span id | `contexts.trace.span_id` | `span_id` |
| parent span id | `contexts.trace.parent_span_id` (may be empty) | `parent_span_id` |
| name | `transaction` | `description`, else `op`; `http.client` spans: the HTTP method (`HTTP` when unknown), as the semantic conventions name client spans, so span metrics keep one series per method instead of one per URL |
| start, end | `start_timestamp`, `timestamp` | same |
| kind | `INTERNAL` | `CLIENT` when `op` starts with `http.client`, else `INTERNAL` |
| status | `contexts.trace.status` | `status` |
| attributes | `sentry.op`, measurements as `ouo.sentry.measurement.<name>` (value in the measurement's unit, unit in `.unit`) | `sentry.op`, allowlisted `data` keys |

Status: `ok` or absent is `Unset`; anything else is `Error` with the Sentry status as the description.

`data` keys copied for HTTP spans: `http.request.method` (or `http.method`, `method`, or the method in `description`), `url` as `url.full`, `http.response.status_code` (or `status_code`), `http.query` dropped. Other `data` keys are not copied. From an absolute `url.full` the receiver adds `server.address`, `server.port` (explicit, else 80 for `http` and 443 for `https`), `url.scheme` and `url.path`, as the ouo SDKs do.

Derived log records (same trace and span id as their span):

- `http.request.failed` for a span with `op` `http.client` and either `http.response.status_code >= 500`, or no status code and span status in `internal_error`, `unavailable`, `deadline_exceeded`, `unknown_error`, `aborted`. Severity `ERROR`, as the ouo SDKs emit it. Attributes `http.request.method`, `url.full`, `http.response.status_code` (absent for network failures), `ouo.sentry.span_status`.
- `http.request` for a span with `op` `http.client` and a status code from 1 to 499, **only when the session has no replay** (no replay id known for it, and none in the envelope's trace header that is not another session's): with a replay, the recording's fetch breadcrumbs bring every request, also those outside transactions (section 9a). Attributes as for `http.request` from breadcrumbs, with the span's trace and span id. A request reaches the timeline once: by span id against fetch breadcrumbs (`data.__span`) from recordings and events.
- `navigation` for a transaction with `op` `ui.load` (iOS view controllers, Android activities) or `navigation` (React Navigation): `url.path` = `transaction`, `ouo.navigation.kind = screen`, `ouo.navigation.source = transaction`, `ouo.navigation.from` = the previous screen of the same session from receiver state, when known. Not emitted when a `navigation` breadcrumb to the same screen within 5 s is already on the timeline (section 9b).

- Mobile vitals (A4): the transaction's `measurements` (`app_start_cold`, `app_start_warm`, `time_to_initial_display`, `time_to_full_display`, `frames_*`, `stall_*`) also become `ouo.app.start`, `ouo.screen.display`, `app.jank` and `ouo.stall` records with the transaction's trace and root span id, as [mobile-vitals.md](mobile-vitals.md) section 6 defines. At most one `ouo.app.start` per session.

Envelope header `trace.replay_id`, when present, feeds the `replay_id -> sid` map (section 8).

## 7a. Structured logs (`log` item)

Sentry logs (`enableLogs: true`, `Sentry.logger.*`) arrive as one `log` item per flush (header `item_count`, `content_type: application/vnd.sentry.items.log+json`). The payload is `{"version": 2, "items": [...]}` (observed `version` 2 with @sentry/core 10.76.0); each entry has `timestamp` (Unix seconds, float), `level`, `body`, `trace_id`, `severity_number` and typed `attributes` (`{"value": ..., "type": "string" | "boolean" | "integer" | "double"}`).

Each entry becomes one log record with `event.name = log`, or `console` for console output (`attributes["sentry.origin"] = auto.log.console`: `enableLogs` in @sentry/react-native 8.30.0 also captures `console.*`, observed):

| Log record | From |
|---|---|
| timestamp | `timestamp` |
| severity number, text | `severity_number` (OTel numbers, 1 to 24), else from `level`; text = `level` upper-cased |
| body, `message` | `body` (`message` truncated to 1 KiB) |
| trace id, span id | `trace_id`, `attributes["sentry.trace.parent_span_id"]` |
| `ouo.sentry.level` | `level` |
| `ouo.sentry.log.template` | `attributes["sentry.message.template"]` (`Sentry.logger.fmt`) |
| `ouo.sentry.origin` | `attributes["sentry.origin"]` |
| other attributes | every attribute the app set, typed, at most 32, string values truncated to 1 KiB |

Not copied onto the record: the SDK's `sentry.*` attributes, `device.*`, `os.*`, `user.email`, `user.name`, `user.ip_address`. A log item travels alone, so its resource (section 4) is built from the entries' `sentry.release`, `sentry.environment`, `sentry.sdk.name`, `sentry.sdk.version`, `os.name`, `os.version` and `device.model`, completed from the session's device context. `user.id` becomes the record's `user.id` when no session supplies one.

Session resolution (section 8): `attributes["sentry.replay_id"]` (rule 2; present on iOS React Native entries, observed), `trace_id` (rule 4), `attributes["user.id"]` (rule 3), then the startup rule (rule 5). A log item never travels with a `session` item, so rule 1 does not apply. The JS SDK flushes logs 5 s after the last one, usually after the transaction that carries the same trace id; an entry whose session is not known yet is held up to `log_hold` (default 1 min) and retried after every envelope and every 5 s. After the hold, or at shutdown, it is emitted without `session.id` (`ouo.sentry.session_match = none`), never dropped. At most 20 000 entries are held; beyond that new entries are emitted without a session.

## 8. Session resolution

Rules in order; the first match wins.

1. **envelope**: the envelope contains exactly one `session` item. Its `sid` applies to every item in the envelope. With several `session` items, the one whose `errors` changed applies to `event` items, and transactions fall through to rule 2.
2. **replay**: the item has a replay id (`contexts.replay.replay_id` on events; envelope header `trace.replay_id` on event and transaction envelopes, both observed), `replay_id -> sid` is known, and the item's time falls inside that session's window (`[started - 1 min, last activity + 30 min]`, or `+ 30 s` once the session has ended). The window check is required: after a background rotation the React Native JS layer keeps sending the previous session's replay id in transaction trace headers. The map is learned from any envelope where rule 1 matched and a replay id is present. Replay segments themselves are matched by replay id without the window check (a session's last segments are flushed after it ended).
3. **device**: `(ouo project, did)` has a session whose window `[started, last_update + 30 min]` contains the item timestamp. The device key of an item is its `user.id` (verified on iOS: the default `user.id` is the installation id the SDK also uses as `did`). When the app sets its own user id, `did` follows it, so the key still matches. For a replay segment the session must also have started at most 10 s after the segment (a replay starts with its session): otherwise a held segment of a session the bridge never saw (bridge restarted mid-replay) would claim the device's next session, and that session's own replay would be dropped as `replay_conflict` (found on a real run).
4. **trace**: the item's trace id (`contexts.trace.trace_id` of events and transactions, `trace_id` of log entries) was seen on an item resolved by rules 1 to 3, and the item's time falls inside that session's window. A trace id can map to several sessions (the JS SDK's scope trace id outlives a background rotation); the latest started session whose window contains the item wins. At most 512 trace ids are remembered per session.
5. **start** (log entries only): console output the app prints while it starts, before sentry-cocoa opened the session (`Running "main"`, the app's own startup lines), carries no replay id, no `user.id` and a trace id nothing else uses. It belongs to the session created from the same network origin (the request's `X-Forwarded-For` chain plus peer address; used for nothing else) whose `started` lies between 10 s after and 5 s before the entry (observed: entries from 60 ms before to 0.7 s after the start). When two or more sessions of that origin qualify (devices behind one address starting together), none matches. Once the entry has its session, its breadcrumb copy in the recording is de-duplicated as any console line (section 9a), so `Running "main"` is stored once.
6. **event** (user feedback only, section 9c): the error or message event the feedback names (`associated_event_id`, a `user_report`'s `event_id`) was emitted in a known session. At most 64 event ids are remembered per session.
7. **none**: emitted without `session.id`.

`ouo.sentry.session_match` on every record and span says which rule matched: `envelope`, `replay`, `device`, `trace`, `start`, `event` or `none`.

State: LRU of `max_sessions` (default 200 000) entries, TTL 4 h after the last update. Replay segments with no resolution are held up to `replay_hold` (default 10 min, at most `replay_hold_max_bytes`, default 256 MiB), retried on every state change, then dropped with reason `replay_unresolved`.

## 9. Replay (`replay_video` item)

### Input

The item payload is a msgpack map with binary values under the keys `replay_event`, `replay_recording`, `replay_video`, in any order (sentry-java writes them in that order; sentry-cocoa varies it between segments, observed). `replay_recording` and `replay_video` may be absent. Observed on iOS: fixmap with str8 keys and bin32 values, uncompressed recording JSON, H.264 mp4 at 1 fps, a segment every 5 to 6 s; `replay_start_timestamp` is present on every segment and equals that segment's start.

- `replay_event` (JSON): `replay_id`, `segment_id`, `replay_type` (`session` or `buffer`), `replay_start_timestamp` (first segment), `timestamp`, `trace_ids`, `platform`, plus scope data (`user`, `contexts`).
- `replay_recording`: a JSON header line `{"segment_id": n}`, a newline, then a JSON array of rrweb-style events. The array may be gzip compressed (check for `1f 8b`).
- `replay_video`: raw mp4 bytes, H.264.

Recording events used:

| rrweb event | Meaning | Fields |
|---|---|---|
| `type: 5` (custom), `data.tag: "video"` | the segment | `timestamp` (ms, segment start), `data.payload`: `segmentId`, `size`, `duration` (ms), `encoding`, `container`, `height`, `width`, `frameCount`, `frameRate`, `frameRateType`, `left`, `top` |
| `type: 3` (incremental), `data.source: 2` (mouse interaction) | a touch start or end | `timestamp`, `data.type` 7 TouchStart, 8 TouchMove_Departed, 9 TouchEnd, 10 TouchCancel; `data.x`, `data.y`, `data.pointerId` |
| `type: 3` (incremental), `data.source: 6` (touch move) | touch moves | `data.positions[]`: `x`, `y`, `id`, `timeOffset` (ms, negative = before the event `timestamp`) |

| `type: 5` (custom), `data.tag: "options"` | masking options, first segment of a replay only | `maskAllText`, `maskAllImages`, `quality`, `maskedViewClasses` |
| `type: 5` (custom), `data.tag: "breadcrumb"` | one breadcrumb (section 9a) | `data.payload`: `category`, `message`, `level`, `data` |

Meta events and other custom events are ignored.

### Output: `kind: "video"` chunk

One chunk per segment, emitted into the replay pipeline (section 10):

```json
{
  "kind": "video",
  "schema_version": 1,
  "session_id": "<sid>",
  "seq": 3,
  "started_at": 1791471538578,
  "ended_at": 1791471543578,
  "viewport": { "width": 288, "height": 624, "scale": 1 },
  "platform": "ios",
  "video": {
    "container": "mp4",
    "encoding": "h264",
    "duration_ms": 5000,
    "frame_count": 5,
    "frame_rate": 1,
    "mp4": "<base64>"
  },
  "touches": [{ "ts": 1791471540828, "x": 120.5, "y": 410, "phase": "began" }],
  "source": { "vendor": "sentry", "replay_id": "<32 hex>", "segment_id": 3, "replay_type": "session" },
  "masked": true
}
```

- `seq` = `segment_id`. `started_at` = the video event `timestamp`; `ended_at` = `started_at + duration`. A segment without a video event or without mp4 bytes is dropped with reason `replay_incomplete`.
- `viewport` = video `width` and `height`, `scale` 1. Touches are copied in the recording's coordinate space, which on iOS is the video's (both in points, 402x874 on an iPhone 18 Pro, observed). Android unverified.
- Touch `phase`: 7 `began`, 8 and source 6 `moved`, 9 and 10 `ended`.
- `platform`: from `contexts.os.name` when present, else `replay_event.platform` (`cocoa` is `ios`, `java` is `android`), else the SDK name (`sentry.cocoa*` is `ios`, `sentry.java*` but not `sentry.javascript*` is `android`). React Native envelopes are named `sentry.javascript.react-native` or `sentry.cocoa.react-native`, never plain `sentry.cocoa`.
- A session keeps the first `replay_id` it sees. Segments of another `replay_id` for the same `sid` are dropped with reason `replay_conflict`.
- `masked` = `maskAllText || maskAllImages` from the replay's `options` event. Later segments inherit the value from the session state. When the options are unknown (bridge restarted mid-replay) `masked` is `true`, the SDK default.

### 9a. Breadcrumbs from the recording

Sentry records the scope's breadcrumbs into the replay recording, each in exactly one segment (observed on iOS: fetches with status code and span id, console output, custom breadcrumbs, app lifecycle). The bridge turns them into session events in the session of the segment, emitted after the chunk, with `ouo.sentry.session_match = replay`. They exist only for sessions that have a replay. A segment retried by the SDK produces identical records, which rum-api de-duplicates (same time, session, name and body). Console lines arrive twice when the app enables Sentry logs (a `console` log entry and a `console` breadcrumb, with timestamps a few microseconds apart): the bridge emits the first copy it sees and drops a second one with the same message within 2 s in the same session.

| Breadcrumb `category` | `event.name` | Attributes |
|---|---|---|
| `fetch`, `xhr`, `http` with `status_code` 1 to 499 | `http.request` | `http.request.method`, `url.full`, `http.response.status_code`; span id from `data.__span` |
| `console` | `console` | `message`, `ouo.sentry.level` |
| `app.*` (`app.inactive`, `app.background`, `app.foreground` on iOS; `app.lifecycle` with `data.state` on Android) | `app.lifecycle` | `ouo.app.state` |
| `ui.tap`, `ui.click`, `touch` | `ui.tap` | `ouo.ui.target` (message, `view.id` or `target`) |
| `navigation` with `data.to` | `navigation` | `url.path` = `to`, `ouo.navigation.from` = `from` (else the session's last screen), `ouo.navigation.kind = screen`, `ouo.navigation.source = breadcrumb`. Paired with transaction navigations (section 9b). Skipped when `message` equals `to`: sentry-cocoa's replay copy of a UIKit view controller event (`RNSScreen` in a React Native app) |
| `sentry.transaction`, `sentry.event` | none | SDK notes |
| anything else | `breadcrumb` | `ouo.breadcrumb.category`, `message`, scalar `data` values as `ouo.breadcrumb.data.<key>` (at most 16, keys starting with `__` skipped) |

Requests that failed (status 500 and above, or no status) are not taken from breadcrumbs: `http.request.failed` comes from the `http.client` span, which carries the trace. A fetch breadcrumb whose `data.__span` is already on the timeline (from its span or another copy) is skipped.

### 9b. Breadcrumbs attached to events

Every `event` carries the scope's last 100 breadcrumbs (`touch`, `fetch`, `xhr`, `navigation`, `navigation.dispatch`, `ui.lifecycle`, `console`, `app.*`, app categories). They are mapped with the table of section 9a, in the event's session and with its `ouo.sentry.session_match`, under these rules:

- Only breadcrumbs from the session's start minus 5 s up to the event time plus 1 s: the scope keeps breadcrumbs across a background rotation, so an error carries the previous session's too.
- **Sessions with a replay** (a replay id known for the session or on the event): only `navigation` breadcrumbs; the recording brings the rest. Recordings rarely carry React Navigation's breadcrumbs (observed: 1 of 8 navigations), so this is how back navigations reach the timeline: the React Native SDK drops a back-navigation transaction without spans (Cart to Home) but still records the breadcrumb `{from: Cart, to: Home}`.
- **Sessions without a replay** (production `replaysSessionSampleRate` is usually 0.1 or less): every category, which gives them taps, answered requests, console, lifecycle and app breadcrumbs. `navigation.dispatch` (React Navigation's note before each `navigation`), `ui.lifecycle` (UIKit view controller events) and `started` (the SDK's start note) are skipped.
- **Copies.** The same breadcrumb arrives on every later error, and sentry-cocoa's crash report repeats the JS breadcrumbs stamped up to about 60 ms later. A breadcrumb with the same category, message and data as one an earlier event of the session brought, within 1 s, is skipped; two identical breadcrumbs in one event are both kept (two taps on one button).
- **Navigation pairing.** A `navigation` breadcrumb and a `ui.load` / `navigation` transaction to the same screen within 5 s are one navigation: whichever arrives second is dropped (a React Navigation transaction starts 10 to 20 ms before its breadcrumb, the app-start `ui.load` up to 3 s before). Copies of a navigation breadcrumb within 1 s are dropped too.

### 9c. User feedback (`feedback` and `user_report` items)

Both become the `feedback` record of the ouo SDK ([mobile-sdk.md](mobile-sdk.md) C10), severity `INFO`, body = the message:

| ouo attribute | `feedback` item (`Sentry.captureFeedback`, sentry-cocoa `SentrySDK.capture(feedback:)`) | `user_report` item (legacy `captureUserFeedback`) |
|---|---|---|
| timestamp | event `timestamp` | received time (the item has none) |
| `ouo.feedback.message` | `contexts.feedback.message`, trimmed | `comments`, trimmed |
| `ouo.feedback.contact` | `contexts.feedback.contact_email`, else `.name` | `email`, else `name` |
| `ouo.feedback.id` | the event's `event_id` as a UUID | none: its `event_id` names the error it is about |
| `ouo.sentry.event_id` | `event_id` | none |
| trace id, span id | `contexts.trace` | none |
| session | rules 1 to 4 (with `contexts.feedback.replay_id` as the replay id when `contexts.replay` has none), else rule 6 by `associated_event_id` | rule 6 by `event_id` |

- An item with an empty message is not translated.
- A `user_report` whose error the bridge does not know yet is held, keyed by that error's event id, as log entries are held (section 7a): up to `log_hold` (default 1 min), retried after every envelope and every 5 s, sharing the 20 000-entry bound (beyond it, emitted at once without a session, drop reason `user_report_unresolved_overflow`). The report can race ahead of its error (both in flight at once). When the error does not arrive in time (the bridge restarted, its state is in memory with a 4 h TTL; the error was sampled out by Sentry's `sampleRate`) or arrives without a session, the report is emitted without a session (`session_match = none`) after the hold or at shutdown, so no session page shows it; it is in Loki.
- Message and contact are cut at 4096 bytes of UTF-8 with `…`, as the ouo SDK cuts them. They are what the user typed into the feedback form, so they are copied although `user.email` is not (section 12).
- The `feedback` event's breadcrumbs become timeline events under the rules of section 9b: the steps before the feedback, which the plugin lists with it. The bridge sets neither `ouo.last_events` nor `ouo.feedback.screenshot`: Sentry's screenshot is an attachment, which is not copied; the session's replay, when there is one, shows the screen at the feedback time.

## 10. Collector wiring

> rum-api, the MVP Grafana plugin and the `ouoreplay` receiver/exporter were removed on 2026-11-15. The bridge's video chunks (`ouo.replay.chunk = true`) are routed to the `debug` exporter until a store takes them (`deploy/compose/collector/config.yaml`); sections 10 and 11 below describe the MVP wiring and API.

Checked against the Phase 8a rev 2 components in `collector/` and `deploy/compose/collector/config.yaml`.

**Project context.** On the OTLP and replay paths, `basicauth` puts the project id in `client.Info.Auth` as `username`. `resource/project` stamps `ouo.project.id` from it, and `ouoratelimit` keys its project bucket on it. The Sentry path has no Basic credential. After the project table lookup, the receiver therefore puts an auth value with `username = <ouo_project_id>` into `client.Info` on the context it hands to its consumers. Both processors then work unchanged. The receiver also sets `client.Info.Addr` to the client address (the TCP peer) and, when the request carries one, puts its `X-Forwarded-For` header into `client.Info.Metadata`, as `include_metadata: true` does on the OTLP receivers, so `ouoratelimit` with `key_from: x_forwarded_for` keys each device behind a proxy separately instead of keying every device on the proxy's address.

**Replay records.** These are the records the `ouoreplay` exporter already consumes, as the `ouoreplay` receiver writes them:
- body: the chunk JSON as bytes;
- resource `ouo.project.id`, and `service.name = ouo-replay`;
- attributes `ouo.project.id`, `session.id`, `ouo.replay.seq` (int), `ouo.replay.kind = video` and `ouo.replay.encoding = json`.

The receiver adds `ouo.replay.chunk = true`. A routing connector uses it to send these records to `logs/replay` and everything else to `logs`.

```yaml
receivers:
  ouosentry:
    endpoint: 0.0.0.0:4320
    max_request_body_size: 20971520
    upstream_timeout: 10s
    translate_queue_size: 10000
    translate_queue_bytes: 268435456
    passthrough_upstream: https://o123.ingest.sentry.io  # optional (section 2a)
    mirror: { queue_bytes: 268435456, timeout: 10s }   # section 2b
    state: { max_sessions: 200000, ttl: 4h, replay_hold: 10m, replay_hold_max_bytes: 268435456, log_hold: 1m }
    projects:
      - sentry_project_id: "4504"
        public_keys: ["<public key>"]
        upstream: https://o123.ingest.sentry.io     # or none
        ouo_project_id: mobile-store
        service_name: mobile-store-ios
        sentry_ui_url: https://acme.sentry.io
        copy_tags: false                            # true: error tags as ouo.sentry.tag.<key> (section 6a)
        mirrors:                                    # optional (section 2b)
          - { name: preview, upstream: https://sentry-preview.example.com, sentry_project_id: "7", public_key: "<preview key>" }

connectors:
  routing/sentry:
    default_pipelines: [logs]
    table:
      - condition: attributes["ouo.replay.chunk"] == true   # exact syntax pinned to the ocb manifest version (0.160.0)
        pipelines: [logs/replay]

service:
  pipelines:
    traces:
      receivers: [otlp, ouosentry]
      processors: [memory_limiter, ouoratelimit, resource/project, batch]
      exporters: [otlp_grpc/tempo]
    logs/sentry:
      receivers: [ouosentry]
      processors: [memory_limiter]
      exporters: [routing/sentry]
    logs:
      receivers: [otlp, routing/sentry]
      processors: [memory_limiter, ouoratelimit, resource/project, transform/events, batch]
      exporters: [otlp_http/loki]
    logs/replay:
      receivers: [ouoreplay, routing/sentry]
      processors: [memory_limiter, ouoratelimit]
      exporters: [ouoreplay]
```

The `ouoreplay` receiver's chunk validation and the `ouoreplay` exporter must accept `kind: "video"`. The exporter copies the body through. The receiver's kind check rejects anything other than `rrweb` and `frames` today, which matters only for clients posting video chunks to port 4319 directly. Bridged chunks never pass through that receiver.

Deployment: the Sentry receiver runs in its own single-replica `ouo-collector` deployment until correlation state moves to a shared store (Phase 11). It exports directly to the backends (the main collector requires a Basic project credential). Client-address affinity is not enough for phones that change networks. Operator guide with the failure modes and a Kubernetes manifest: [sentry-bridge-deployment.md](../sentry-bridge-deployment.md).

Metrics: `ouo_sentry_envelopes_total{project,outcome}` (`forwarded`, `passthrough`, `accepted_local`, `rejected`, `upstream_error`), `ouo_sentry_upstream_duration_seconds`, `ouo_sentry_items_total{type,translated}`, `ouo_sentry_translate_dropped_total{reason}` (`queue_full`, `queue_bytes`, `panic`, `malformed`, `encoding`, `replay_unresolved`, `replay_conflict`, `replay_incomplete`, `log_unresolved_overflow`, `user_report_unresolved_overflow`), `ouo_sentry_session_match_total{rule}`, and the mirror metrics of section 2b.

## 11. rum-api: video replay kind

Additions to `services/rum-api/README.md` and ADR-0006's contract, nothing else changes:

- `POST /v1/replay/chunks` accepts `kind: "video"`. Validation: `schema_version` 1, `started_at > 0`, `ended_at >= started_at`, `viewport.width/height > 0`, `video.container == "mp4"`, `video.mp4` decodes (padded or unpadded base64) to at most `MAX_VIDEO_CHUNK_BYTES` (default 8 MiB) and has `ftyp` at byte offset 4, touches as for frames. `source` is optional and stored.
- Storage: `<seq>.mp4` and `<seq>.json.gz` (the chunk without `video.mp4`, with `video.bytes`), both written atomically under the per-session lock, mp4 first. `meta.json` `kind: "video"`; mixing kinds is `409` as today.
- `GET /v1/sessions/{id}/replay`: meta with `kind: "video"`, `viewport`, `platform`, `chunks[].duration_ms`, `frame_count` total.
- `GET /v1/sessions/{id}/replay/video`:

  ```json
  {"session_id":"<id>","kind":"video","viewport":{"width":288,"height":624,"scale":1},"platform":"ios",
   "started_at":1791471538578,"ended_at":1791471548578,
   "segments":[{"seq":0,"started_at":1791471538578,"ended_at":1791471543578,"duration_ms":5000,"frame_count":5,"bytes":48211,
                "path":"/v1/sessions/<id>/replay/video/0"}],
   "touches":[{"ts":1791471540828,"x":120.5,"y":410,"phase":"began"}],
   "source":{"vendor":"sentry","replay_id":"<32 hex>"}}
  ```

- `GET /v1/sessions/{id}/replay/video/{seq}`: `video/mp4` through `http.ServeContent` (range requests, `Last-Modified`), `404` when the segment is missing.
- `409` when the replay is not video; `/replay/events` and `/replay/frames` return `409` for a video replay. All three streaming endpoints set `X-Ouo-Replay-Kind`.
- Session list and detail: `replay_kind: "video"`, `replay_duration_ms` from the meta, `replay_frame_count` from the video frame counts.

Clarifications from the implementation (rum-api, 2026-10-14):

- Body limit: a video chunk body (base64 mp4 plus envelope) may be up to `base64(MAX_VIDEO_CHUNK_BYTES) + 1 MiB`, about 12.2 MiB by default, compressed and decompressed. A body above it is `413` before parsing; a decoded mp4 above `MAX_VIDEO_CHUNK_BYTES` is `413` too (not `400`). Whatever forwards video chunks to rum-api (the `ouoreplay` exporter) must allow bodies of that size.
- Optional `video` fields: `encoding` (string), `duration_ms` and `frame_count` (integers >= 0), `frame_rate` (number). A segment's duration is `video.duration_ms`, or `ended_at - started_at` without it. `source.vendor` and `source.replay_id` must be strings when present.
- `202` body as for the other kinds: `frames` is `video.frame_count`, `touches` the touch count, `events` 0.
- Meta: `chunks[]` of a video replay carry `duration_ms` and `video_bytes` (mp4 size); `source` is `{vendor, replay_id}` of the first chunk that had one. `segment_id` and `replay_type` stay in the chunk file.
- Segment endpoint: also `ETag` (size and mtime, so a `seq` replaced within the same second is not served from cache), `Cache-Control: private, no-cache`, `400` for a `seq` outside `0..999999`, `416` for an unsatisfiable range. The manifest's `path` is relative to the rum-api root; the plugin maps it onto its proxy route. Its `source` is `null` when no chunk had one.

Plugin (`plugins/ouo11y-rum-app`): a video player mounted when `replay_kind` is `video`. One `<video>` element per segment in sequence (preload the next), global time to `(segment, offset)` mapping for the scrubber and timeline markers, touch overlay fading over 500 ms as in the frame player, gaps between segments shown as a still of the last frame.

## 12. Attribute allowlist

Only the attributes named in sections 4 to 9b are produced. In particular these Sentry fields are never copied: `user.ip_address`, `user.email`, `user.username`, `request.*`, `extra`, `tags` (unless the project sets `copy_tags`), `contexts` other than `os`, `device.model`, the section 6a allowlist, `trace`, `replay`, `threads`, attachments, view hierarchies and screenshots attached to errors, and debug images the stack does not point into. User feedback (section 9c) copies the message and contact the user typed. Three inputs carry app-chosen content by design: the attributes of Sentry log entries (section 7a), the message and `data` of breadcrumbs (sections 9a, 9b), and tags with `copy_tags`; apps decide what they put there.

## 13. Expected differences between Sentry and ouo

| Topic | Sentry | ouo through the bridge |
|---|---|---|
| Crash-free sessions | `crashed` / total | `crashed` / total, same unless upstream rejected envelopes the bridge therefore skipped |
| ANRs and app hangs | `abnormal` (ANR) or error events | `session.end` reason `terminated`; the ANR error event counts as `errored` |
| Errored sessions | `errors > 0` | same, through synthetic unsampled errors (section 5) |
| Traces per session | sampled by `tracesSampleRate` | same sampled set; `trace_count` and derived `http.request.failed` / `navigation` are lower than a fully traced ouo SDK would produce |
| Session boundaries | Sentry's (30 s background) | Sentry's; ouo's own SDK rules do not apply to bridged apps |
| Replay | session or on-error buffer sampling | exactly the segments Sentry accepted |
| Logs | Sentry Logs | `log` session events in Loki; the few whose trace id no error or transaction ever carried have no session |
| Breadcrumbs | attached to error events and in the replay | timeline events: from the recording for sessions with a replay, from the error events' breadcrumbs (and answered requests from `http.client` spans) for sessions without one; a session without a replay and without errors has only navigations, failed requests and logs |
| Messages | `captureMessage` at info is an event, not an error | `sentry.message`, not counted as an error |

## 14. Verification

Done on 2026-10-14 for iOS; results in `project/reports/sentry-bridge-verification.html`.

1. **Capture.** `examples/sentry-mobile` (Expo app on `@sentry/react-native` 8.30.0, sentry-cocoa 9.30.1) drives an unattended journey on the iOS Simulator (`scripts/journey.sh`). `collector/tools/sentrytap` records every request in front of the bridge (A) and at a fake Sentry behind it (B). Two captures are committed as golden fixtures in `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/`; findings in `project/kb-archive/sentry-react-native-demo.md` and `project/kb-archive/sentry-envelope-format.md`.
2. **Unit tests**: envelope parser, msgpack decoder (both fuzzed), forwarding against a fake upstream (body and headers byte-identical, status and rate-limit headers echoed, unknown key `403` and not forwarded, upstream non-2xx not translated, unreachable upstream aborts the connection), translation of a synthetic journey, restart baseline, replay resolution and hold queue, and golden tests on the real captures with an invariant that nothing lands outside its session's window.
3. **rum-api tests**: video chunk validation, storage, manifest, range request, cross-kind `409`.
4. **End to end**: `sentrytap compare A B` must report every request byte-identical with identical responses; `examples/sentry-mobile/scripts/verify-bridge.py` derives sessions, errors, transactions and replays from the raw envelopes and checks rum-api, Loki, Tempo and every mp4 (sha256 and AVFoundation decode). A run with the fake Sentry stopped checks that the SDK retries and that ouo records each event once.
5. **Real upstream** (N2, 2026-10-18, and again 2026-10-23 for the parity fixes): self-hosted Sentry 26.10 as the upstream, `examples/sentry-mobile` on the iOS Simulator with real taps; counts compared with Sentry's own (`project/kb-archive/sentry-self-hosted.md`). The N2 capture is the golden fixture `ios-rn-8.30.0/selfhosted`; `ios-rn-8.30.0/journey` is also replayed with every replay item and replay id removed, for sessions without a replay.
6. **SDK versions** (2026-10-23, N3): golden journeys of 7.11.0 and 8.32.0 next to 8.30.0, tested by `versions_test.go`; captured while `examples/sentry-mobile/scripts/verify.py` checked the same run end to end.
7. **Mirrors and passthrough** (2026-11-15, ADR-0028): unit and failure-injection tests (`mirror_test.go`: a hanging, a `500` and a `429` mirror next to a healthy primary, the byte budget, primary down, credential rewrite, translator panic), and an end-to-end run with self-hosted Sentry 26.10 as the primary and a recording upstream as the mirror (`project/agents/sentry-demo/reports/sentry-mirror-readiness.html`).
8. **Not done yet**: Android, native sentry-cocoa without React Native, a quota-limited Sentry (real `429`).
