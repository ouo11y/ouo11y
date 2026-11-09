# RUM conventions: sessions

Rules, status words and sources are in [rules.md](rules.md). Choices here are **Proposed**.

## What OTel defines

Dev core v1.45.0. Moving to client-side with names unchanged (PR #48 and core PR #4306, both open).

| Name | Kind | Rule |
|---|---|---|
| `session.id` | Attribute | Opt-in in the `session-id` group; required on session events |
| `session.previous_id` | Attribute | Must differ from `session.id` |
| `session.start` | Event | MUST be emitted each time a session is created. MUST carry `session.previous_id` if it continues a prior session |
| `session.end` | Event | SHOULD be emitted, and before the following `session.start` |

The convention already handles unreliable ends: a `session.start` with `session.previous_id` means the previous session ended, and "the consumer SHOULD treat this continuation event as semantically equivalent to" an end plus a start.

SIG notes record "we don't have a great definition of session". All three OTel SDKs agree that a session is a time-boxed correlation id, not a user identity.

## How the SDKs behave

| | Browser | Android | Swift |
|---|---|---|---|
| Where | Span and log processors add `session.id` | Same model | Span and log processors add `session.id` and `session.previous_id` |
| Timeouts | None by default; examples use 30 min inactive and 4 h max | 15 min in background, 4 h max | 30 min inactive, max optional |
| Inactivity means | No span or log **through the processors**, not user input | Time in background | Access extends the deadline |
| Persistence | `localStorage`, one session **per origin** across tabs | No session store found in the code | Versioned on device, with a sampling decision |
| Sampling | No | `SessionIdRatioBasedSampler`, derived from the session id | **Session-level decision shared by traces, logs and metrics** |
| Start/end events | Observer hooks; events on the roadmap | `session.start`, `session.end` | `session.start`, `session.end` |

The browser's inactivity definition is a trap: background telemetry keeps a session alive when the user has gone.

## Event or span

**Events.** A span lasting a session would be open across hours, and would die with the tab. Browser issue #23 makes the same point about a session-long trace.

## Where `session.id` lives (Q2)

**A record attribute on every log and span**, as all three SDKs do, and as the convention says. Not a resource attribute:

- A session changes during an SDK's life, while a resource is fixed. Modelling it as a mutable entity is the direction (browser PR #269, a demo, and the roadmap), but entities are not ready.
- As a resource attribute, it would become a stream field on VictoriaLogs and promote to a label on VictoriaMetrics ([Step 1](../storage-backends/signal-choice-and-backends.md)).

`session.previous_id` only on `session.start`, as the browser does. Repeating it on each record, as Swift does, costs bytes without use.

## Are start and end enough (Q20)?

Yes, as long as the server treats `session.end` as a hint. Session end is the earliest of an explicit `session.end`, a `session.start` naming it as previous, or the last record plus the inactivity timeout. That matches the core text, and a mobile app killed in the background still ends cleanly.

## Session health (Q21)

Computable from events alone: count distinct `session.id` from `session.start`, and subtract those with `app.crash`, `exception` at FATAL or unhandled, or `device.anr` / `ouo.app.hang`. Needs no new client field. The definition of "unhealthy" is a Step 3 or later choice.

Because a crash is delivered on the next launch, session health for recent sessions will lag and change. The product needs to say so.

## Sampling (Q22)

Decide once per session, at session start. Persist it, and apply it to every signal. Swift already works this way (`SessionSampling`, `SessionTraceSampler`), and Android samples by session id. Trace sampling inherits the session's decision, and sets the sampled flag in `traceparent`, so a parent-based backend keeps the same sessions. Errors and crashes can bypass session sampling. How is a Step 3 question.

Prediction: this model reaches the other SDKs. Medium.

## Vendor names

| | Sentry | Datadog | PostHog |
|---|---|---|---|
| Session id | `sid` in a session envelope | `session.id` | `$session_id` |
| Tab or window | | | `$window_id` |
| Has replay | `sentry.replay_id` | `session.has_replay` | |

PostHog's `$window_id` answers the same problem as browser issue #84: tabs that share a session.
