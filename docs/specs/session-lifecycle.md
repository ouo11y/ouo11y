# Session lifecycle specification

Status: normative for the MVP. Changes require an ADR.

## Definitions

- **Session**: a bounded period of one user using one app instance on one device. Identified by `session.id` (UUID v4, generated client-side).
- **User**: `user.id` set by the app when known, otherwise an anonymous id persisted on the device (`ouo.user.anonymous = true`).
- **Activity**: any of user interaction (click, key press, touch, scroll), navigation or route change, an outbound HTTP request, or an app foreground event.
- **Session status**: one of `healthy`, `errored`, `crashed` (ADR-0004).

## Identifiers carried on every signal

Every span, log record and metric data point emitted by an SDK carries:

| Attribute | Source |
|---|---|
| `session.id` | SDK session manager |
| `session.previous_id` | set on the first signals of a session that replaced an expired one |
| `user.id` | app-provided or anonymous |
| `service.name` | SDK config (`web-store`, `mobile-store`) |
| `service.version` | app version, the "app version" dimension for health percentages |
| `deployment.environment.name` | SDK config |
| `ouo.platform` | `web` or `mobile` |

Spans get these through a SpanProcessor. Log records get them as attributes. Session attributes are **not** resource attributes because a session can rotate while the process lives.

## Consent: no session before consent (ADR-0018)

An SDK initialised with `consent: "pending"` has no session until the app grants telemetry.

1. While pending the SDK stores nothing on the device (web: no `localStorage`, IndexedDB or cookie; mobile: nothing in its key/value storage, no native crash handler, no native recorder), opens no cross-tab channel, sends nothing and installs no instrumentation. `session.id()` is empty. No `session.start` is emitted and no session id exists anywhere.
2. Public API calls made while pending (`setUser`, `clearUser`, `captureError`, `addEvent`, `setRoute`; mobile `log.*` and the last `trackNavigation`) wait in memory, at most 100, oldest dropped first. Activity, taps and spans while pending are not recorded.
3. `setConsent({ telemetry: true, replay })` starts the SDK: the start rules below apply from that moment (a persisted session from an earlier granted visit may resume), then the queued calls run in order, stamped at the grant.
4. `replay` is a separate grant on top of `telemetry`: without it the replay recorder is never started (or is paused), whatever sampling or `replay.resume()` say. `replay` without `telemetry` means nothing.
5. `setConsent({ telemetry: false })` (revocation or refusal) stops capture and export at once; what is still batched is dropped, not sent or stored. The SDK deletes its own stored identifiers (`ouo.device`, `ouo.session`, `ouo.user` and, on mobile, the crash marker, error context and replay tallies) and its offline store, and closes its channels. Calls after it are dropped. Web: other running tabs of the origin see `ouo.device` removed and stop too, writing nothing back; a grant after a revocation never resumes a session from before it. A later grant starts a new `device.id` and a new session, with no `session.previous_id`.
6. The SDK never persists the consent. The app passes its consent manager's decision at every start; `consent: "granted"` (the default) starts at once as before.

## Start rules

### Web

1. On SDK init, read the persisted session from `localStorage` key `ouo.session`.
2. If it exists and `now - lastActivity < INACTIVITY_TIMEOUT` and `now - startedAt < MAX_DURATION`, resume it. No `session.start` event is emitted.
3. Otherwise create a new session and emit `session.start`. If an expired session was found, emit `session.end` for it first with the inferred end reason and set `session.previous_id`.
4. Tabs of the same origin share the session via `localStorage`; the `storage` event keeps them in sync.

### Mobile

1. On cold start, create a new session and emit `session.start`. If a persisted session marker exists from a previous run, emit `session.end` for it: reason `crash` if a crash marker exists, otherwise `terminated`.
2. On foreground after being in background for more than `BACKGROUND_TIMEOUT`, end the current session (reason `background`) and start a new one.

## Activity rules

Every activity updates `lastActivity` in memory and, throttled to once per second, in persistent storage.

## End rules

A session ends when the first of these happens:

| Reason | Condition | Who detects |
|---|---|---|
| `inactivity` | no activity for `INACTIVITY_TIMEOUT` (default 30 min) | SDK timer, or next SDK init, or server inference |
| `max_duration` | session older than `MAX_DURATION` (default 4 h) | SDK, or server inference |
| `background` | mobile app in background longer than `BACKGROUND_TIMEOUT` (default 30 s) | SDK on foreground |
| `crash` | fatal error (mobile JS fatal, web uncaught error does not end the session) | SDK, best effort, plus marker on next launch |
| `terminated` | mobile process ended without a crash marker | SDK on next launch |
| `user_change` | the identified user changed: `setUser` with another identified id, a logout (`clearUser`), or an init with a different identified user than the resumed session's | SDK, at once; a new session starts immediately |
| `manual` | the app called `endSession()` | SDK; the next activity starts a new session |

The SDK emits `session.end` with `ouo.session.end_reason` when it detects any of these. The server **must not depend on it**: a session with no `session.end` is treated as ended when `now - lastSignal > INACTIVITY_TIMEOUT`, and as `active` otherwise.

Web uncaught errors do not end the session; they mark it `crashed` (ADR-0004) and the user keeps using the page.

## User and device

- A session belongs to one identified user. Going from anonymous to identified (a login during the visit) keeps the session and only sets `user.id`: the anonymous id was never a person. Going from one identified user to another ends the session with `user_change`; its `session.end` carries the previous `user.id`, and the next session (with `session.previous_id`) the new one. A logout returns to a fresh anonymous id, also with `user_change`.
- `device.id` (OTel semantic conventions) identifies the browser profile (web: per origin) or the app install (mobile). It is random, persisted apart from the session and the user, and survives session rotation, login and logout, so it links the sessions of one device. It is a resource attribute and is on `session.start` / `session.end`. Where storage is unavailable it lasts as long as the page or process. It is never derived from the IP address or a fingerprint.

## Defaults

```
INACTIVITY_TIMEOUT = 30 min
MAX_DURATION       = 4 h
BACKGROUND_TIMEOUT = 30 s
```

All configurable in the SDK init options.

## Session events (OTel log records)

| `event.name` | Required attributes |
|---|---|
| `session.start` | identifiers above, `ouo.session.started_at`, `device.id` when the SDK has one |
| `session.end` | identifiers, `ouo.session.end_reason`, `ouo.session.duration_ms`, `device.id` when the SDK has one |
| `exception` | identifiers, `exception.type`, `exception.message`, `exception.stacktrace`, `ouo.exception.fatal` (bool), `ouo.exception.handled` (bool) |
| `http.request.failed` | identifiers, `http.request.method`, `url.full`, `http.response.status_code` |
| `navigation` | identifiers, `url.path`, `ouo.navigation.from` |
| `web_vital` | identifiers, `ouo.web_vital.name`, `ouo.web_vital.value`, `ouo.web_vital.rating` |

Event names and attribute names follow OTel semantic conventions where they exist; everything else is prefixed `ouo.`.

## Server-side session record

rum-api folds all signals with the same `session.id` into:

```json
{
  "session_id": "...",
  "user_id": "...",
  "device_id": "... (omitted when the SDK sends none)",
  "platform": "web",
  "service_name": "web-store",
  "service_version": "1.2.0",
  "started_at": "...",
  "last_signal_at": "...",
  "ended_at": null,
  "end_reason": null,
  "state": "active | ended",
  "status": "healthy | errored | crashed",
  "error_count": 0,
  "crash_count": 0,
  "trace_count": 0,
  "has_replay": true
}
```

## Test cases every SDK must cover

1. Fresh init creates a session and emits `session.start`.
2. Init within the inactivity window resumes the session with no new event.
3. Init after the inactivity window ends the old session (`inactivity`) and starts a new one with `session.previous_id` set.
4. Activity after `MAX_DURATION` rotates the session (`max_duration`).
5. Mobile: background longer than `BACKGROUND_TIMEOUT` then foreground rotates the session (`background`).
6. Mobile: fatal error emits `exception` with `ouo.exception.fatal = true`, writes the crash marker, and the next launch emits `session.end` with reason `crash`.
7. Every span and log record emitted during a session carries `session.id`.
8. Anonymous to identified keeps the session; one identified user to another ends it with `user_change` (the end carries the previous user) and starts a new one with `session.previous_id`; a logout does the same with a fresh anonymous id.
9. `endSession()` emits `session.end` with `manual`; the next activity starts a new session with `session.previous_id`.
10. `device.id` is the same before and after rotation, login and logout.
11. Consent pending: no storage read or write, no channel, no network request and no `session.start` until the grant; calls made meanwhile are delivered after `session.start`, the oldest beyond the cap dropped.
12. Consent revoked: no request after the revocation, the stored ids and the offline store are gone, and the next grant has a new `session.id` and `device.id`.
13. Telemetry granted without replay: no replay chunk is recorded or sent; granting replay later starts it in the same session.
