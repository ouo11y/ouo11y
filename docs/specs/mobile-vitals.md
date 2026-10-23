# Mobile vitals specification

Status: normative from 2026-10-23 (checklist A4 for the Sentry bridge, G2 for the ouo React Native SDK). Both producers emit exactly the records below, so rum-api and the plugin read one format whatever the path.

Producers:

- the `ouosentry` bridge (`collector/receiver/ouosentryreceiver`), from the `measurements` of Sentry transactions (section 6);
- `@ouo11y/react-native` (and later the native ouo SDKs), from its own measurements (section 5).

Scope: cold and warm app start, time to initial display (TTID) per screen, time to full display (TTFD) when the app reports it, slow and frozen frames, and JavaScript event-loop stalls. Web vitals stay the `web_vital` event of the session lifecycle spec.

## 1. Record type

Every vital is an **OTel log record (event)** on the logs signal, like the other session events (`docs/specs/session-lifecycle.md`):

- `event.name` from section 2; body empty;
- the session identifiers of the session lifecycle spec on every record (`session.id`, `user.id`, `service.name`, `service.version`, `deployment.environment.name`, `ouo.platform = mobile`), resource attributes as for every other record of the producer;
- trace id and span id: the span that measured the vital when there is one (the Sentry transaction, the ouo SDK's navigation or app-start span), else none;
- severity `INFO` (`severity_number` 9);
- timestamp: the **end** of the measured interval (first frame drawn, screen displayed, end of the frames or stall window). The interval start is `timestamp - duration`. Using the end keeps every record inside its session: an app start begins before the session exists.

Vitals are events rather than metrics because they belong to one session and one screen and are shown on the session timeline. Aggregates across sessions (p75 app start per version) are computed from these events in Loki; a metrics form can be added later without changing this spec.

## 2. Names, attributes and units

Rule: an OTel semantic convention is used where one exists (the `app.*` registry, Development status, checked against semconv on 2026-10-23); everything else is `ouo.`-prefixed. Durations in `ouo.` attributes are milliseconds as doubles, with the unit in the name (`_ms`), as `ouo.session.duration_ms`; the semconv `app.jank.*` attributes keep their unit, seconds. Counts are integers.

### 2.1 `ouo.app.start`

One per process launch that the producer measured. OTel defines no app start event, hence the `ouo.` name.

| Attribute | Type | Req | Meaning |
|---|---|---|---|
| `ouo.app.start.type` | string | yes | `cold` (process started) or `warm` (process alive, app relaunched to the first screen, for example a React Native reload or an Android activity recreate) |
| `ouo.app.start.duration_ms` | double | yes | from process start (cold) or relaunch (warm) to the first frame of the first screen |
| `app.screen.name` | string | no | the first screen |

### 2.2 `ouo.screen.display`

One per screen load that the producer measured (a navigation to a screen, including the first one).

| Attribute | Type | Req | Meaning |
|---|---|---|---|
| `app.screen.name` | string | yes | the screen (React Navigation route name, view controller or activity) |
| `ouo.screen.ttid_ms` | double | yes | time to initial display: from the navigation start to the first frame of the new screen |
| `ouo.screen.ttfd_ms` | double | no | time to full display: to the moment the app reported the screen as fully drawn (Sentry `<TimeToFullDisplay>` / ouo SDK API); absent when the app does not report it |

### 2.3 `app.jank`

The semconv event for "substandard UI rendering performance". One per measured window (a screen load or a user interaction) that drew at least one frame.

| Attribute | Type | Req | Meaning |
|---|---|---|---|
| `app.jank.frame_count` | int | yes | slow plus frozen frames in the window |
| `app.jank.period` | double, s | yes | length of the window |
| `app.jank.threshold` | double, s | no | the slow-frame threshold: the device's expected frame duration (1/60 s at 60 Hz, 1/120 s at 120 Hz); absent when the producer does not know it (the bridge) |
| `ouo.frames.total` | int | yes | frames drawn in the window |
| `ouo.frames.slow` | int | yes | frames longer than the expected frame duration and shorter than 700 ms |
| `ouo.frames.frozen` | int | yes | frames of 700 ms or longer |
| `ouo.frames.delay_ms` | double | no | total time frames ran over their expected duration |
| `app.screen.name` | string | no | the screen the window belongs to |

Slow and frozen follow Sentry's and Android vitals' definitions, so the two paths count the same frames.

### 2.4 `ouo.stall`

JavaScript event-loop stalls (React Native). One per measured window that had at least one stall. Native main-thread hangs are errors (`exception` with the hang mechanism), not stalls.

| Attribute | Type | Req | Meaning |
|---|---|---|---|
| `ouo.stall.count` | int | yes | stalls in the window |
| `ouo.stall.total_ms` | double | yes | sum of the stall times |
| `ouo.stall.longest_ms` | double | yes | longest stall |
| `ouo.stall.period_ms` | double | no | length of the window |
| `app.screen.name` | string | no | the screen the window belongs to |

A stall is a loop iteration that took at least 100 ms when it was scheduled every 50 ms; its stall time is the excess over 50 ms (Sentry React Native's `stallTracking` defaults, so both paths agree).

### 2.5 Common optional attributes

| Attribute | Meaning |
|---|---|
| `ouo.vital.source` | `sentry` (bridge) or `ouo` (ouo SDK) |
| `ouo.vital.window` | what the window of an `app.jank` or `ouo.stall` record was: `screen` (a screen load), `interaction` (a user action), `app_start` |

The bridge also keeps `ouo.sentry.session_match` and `ouo.sentry.measurement.*` on the transaction span (sentry-bridge spec section 7); the records here are additional.

## 3. Rules for producers

1. Emit a record only for a value that was measured. No zeros for "unknown". `app.jank` needs `ouo.frames.total > 0`; `ouo.stall` needs `ouo.stall.count > 0`.
2. Values are not rounded beyond what the platform gives. Negative values and durations above 1 hour are dropped (clock jumps).
3. At most one `ouo.app.start` per session, at most one `ouo.screen.display` per navigation.
4. `session.id` is the session the end of the interval falls in.

## 4. Thresholds used by rum-api and the plugin

Ratings shown in the plugin (`good`, `needs-improvement`, `poor`), from Android vitals and Apple's guidance; they are display hints and not stored:

| Vital | good | poor |
|---|---|---|
| cold start | < 2 000 ms | >= 5 000 ms |
| warm start | < 1 000 ms | >= 2 000 ms |
| TTID | < 1 000 ms | >= 2 500 ms |
| slow frames (`slow / total`) | < 5 % | >= 25 % |
| frozen frames | 0 | >= 1 |
| stalls (`total_ms` per window) | 0 | >= 1 000 ms |

## 5. ouo SDK (`@ouo11y/react-native`)

What the SDK measures to fill the records; how is the SDK's choice as long as the definitions above hold.

- **App start**: cold from the native process start time (`sysctl` `kp_proc.p_starttime` on iOS, `Process.getStartUptimeMillis()` on Android) to the first frame after the root component mounted; warm from the JS reload or activity re-creation. Emitted once the session exists, with the end-of-interval timestamp.
- **TTID**: from the navigation state change (or app start for the first screen) to the next frame drawn after the new screen rendered.
- **Frames**: native frame callbacks (`CADisplayLink` on iOS, `FrameMetrics` / `Choreographer` on Android), summarised per screen load window and per interaction window, threshold from the display refresh rate.
- **Stalls**: the 50 ms loop described in 2.4.

## 6. Sentry bridge mapping

From each `transaction` item's `measurements` (observed names and units in @sentry/react-native 8.30.0 on iOS, golden captures `ios-rn-8.30.0`):

| Sentry measurement (unit) | Record |
|---|---|
| `app_start_cold` (millisecond) | `ouo.app.start`, `type = cold`, `duration_ms` = value |
| `app_start_warm` (millisecond) | `ouo.app.start`, `type = warm`, `duration_ms` = value |
| `time_to_initial_display` (millisecond) | `ouo.screen.display`, `ttid_ms` = value |
| `time_to_full_display` (millisecond) | `ttfd_ms` on the same `ouo.screen.display` |
| `frames_total`, `frames_slow`, `frames_frozen` (none), `frames_delay` (second) | `app.jank`: `ouo.frames.*`, `app.jank.frame_count = slow + frozen`, `ouo.frames.delay_ms = frames_delay * 1000`, `app.jank.period` = transaction duration in s |
| `stall_count` (none), `stall_total_time`, `stall_longest_time` (millisecond) | `ouo.stall`: `count`, `total_ms`, `longest_ms`, `ouo.stall.period_ms` = transaction duration |

- Values in another unit than listed are converted (`second` × 1000 to ms, `nanosecond` / 1e6); an unknown unit drops that measurement.
- Timestamps: `ouo.app.start` at `start_timestamp + duration` of the transaction that carries it (the app start span starts at process start); `ouo.screen.display` at `start_timestamp + ttid`; `app.jank` and `ouo.stall` at the transaction `timestamp`.
- `app.screen.name`: the transaction name for `ui.load` and `navigation` transactions; the session's current screen (receiver state) for `ui.action` and other ops.
- `ouo.vital.window`: `screen` for `ui.load` / `navigation`, `interaction` for `ui.action`, else omitted.
- Trace and span id: the transaction's root span.
- Session resolution as for the transaction (sentry-bridge spec section 8). Only one `ouo.app.start` per session is emitted (the receiver remembers it per `sid`).

## 7. rum-api

- `GET /v1/sessions/{id}/vitals`:

  ```json
  {"session_id":"<id>",
   "summary":{"app_start":{"type":"cold","duration_ms":3060.7,"rating":"needs-improvement"},
              "screens":4,"ttid_ms":{"p50":410.2,"max":3316.2},
              "frames":{"total":1840,"slow":31,"frozen":0,"slow_ratio":0.0168},
              "stalls":{"count":2,"total_ms":340,"longest_ms":220}},
   "vitals":[{"ts":"2026-10-23T10:00:03.316Z","name":"ouo.screen.display","screen":"Home",
              "trace_id":"<32 hex>","span_id":"<16 hex>","values":{"ttid_ms":3316.2},"rating":"poor"}]}
  ```

  `summary` fields are absent (not zero) when the session has no record of that kind. `vitals[].values` holds the record's numeric attributes without their prefix (`ttid_ms`, `duration_ms`, `total`, `slow`, `frozen`, `delay_ms`, `count`, `longest_ms`, ...), `type` for app starts.
- The session detail timeline (`GET /v1/sessions/{id}`, `timeline[]`) returns the four event names with type `vital`.
- Session list and detail: `app_start_ms` and `app_start_type` when the session has an `ouo.app.start`.

## 8. Plugin

- Session header: app start (type, duration, rating colour), TTID p50 / max, slow and frozen frames, stalls; hidden when the session has none.
- Timeline: one entry per record, titled `App start (cold) 3.06 s`, `Home displayed in 3.32 s`, `Janky frames 5 / 120 (1 frozen)`, `2 JS stalls, longest 220 ms`, coloured by rating.
