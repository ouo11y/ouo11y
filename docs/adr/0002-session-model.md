# ADR-0002 Session model and identifiers

Status: accepted (2026-10-06)

## Context

"Session" must mean the same thing on web, mobile and the server, and must be derivable even when the client never reports a clean end.

## Decision

- `session.id` is a client-generated UUID v4. `user.id` is app-provided or an anonymous persisted id. Both travel as span and log attributes, never as resource attributes.
- Session start, activity and end rules are normative in `docs/specs/session-lifecycle.md`. Defaults: 30 min inactivity, 4 h max duration, 30 s mobile background timeout.
- The server infers session end from the last signal timestamp; the client's `session.end` event is advisory and carries the end reason when available.
- No "view" entity in the MVP. Route changes are `navigation` events with `url.path`.
- OTel semantic conventions are used for `session.id`, `session.previous_id`, `user.id`, `service.*`, `exception.*`, `http.*`, `url.*`, `browser.*`, `os.*`, `device.*`. Everything without an upstream convention is prefixed `ouo.`.

## Consequences

- SDKs need a persistent store (localStorage on web, AsyncStorage on mobile) and a small state machine, both covered by the seven test cases in the spec.
- The server must handle sessions with no end event as the normal case.
