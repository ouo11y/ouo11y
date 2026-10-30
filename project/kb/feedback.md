# User feedback (C10): what the SDK, the bridge and the plugin do, and why

Work package W6, 2026-10-30. Spec: [mobile-sdk.md](../../docs/specs/mobile-sdk.md) C10, bridge: [sentry-bridge.md](../../docs/specs/sentry-bridge.md) section 9c.

## The last events: one buffer, built for errors too

- `sdk/react-native/src/telemetry/recent.ts` (`RecentEvents`) is a `LogRecordProcessor` placed right after `SessionLogProcessor`: every event and log line passes through it with its `session.id`, before sampling. It keeps the last 20 as `{ts, name, body}` and `read(sessionId)` returns that session's entries, oldest first. `lastEventsAttribute()` turns them into the `ouo.last_events` JSON string.
- Reading before emitting keeps the record itself out of its own list. Filtering by session at read time is enough for rotations: a new session starts with an empty view without clearing anything.
- The body is the readable step: navigation path, `Type: message` of an error, `METHOD url status` of a request (the request records' body lacks the status), else the record's body when it is more than its name. Vitals have none (their step is in attributes the plugin names: "Screen displayed", "Janky frames").
- W4 reuses it for `exception` (error context): `recent.read(session.id())` before `events.emit("exception", ...)`.
- One JSON string attribute, not an OTLP array: Loki keeps attributes as structured metadata strings and rum-api returns them as strings, so the plugin parses one value either way.

## The screenshot is the replay, not an image

- `screenshot: true` calls the recorder's existing `screenDidChange()` (no native change): `navigation` mode takes a frame once the screen settled; `session` mode ignores it because its interval frames already show the screen.
- The frame deduper drops a frame equal to the last one, so on a static screen no new frame appears after the feedback (seen on the simulator: the last frame was 1.1 to 1.6 s before it, the next one at the next screen). A "first frame after the feedback" seek would land on the next screen. The plugin therefore seeks to the feedback time: the player shows the frame on screen then. The checks (C10.1, `verify.py --feedback`) ask for a frame at or before the feedback and frames after it.
- A dedicated frame reason (`FrameReason.feedback`) that bypasses the deduper would need `sdk/ios` changes (`ReplayRecorder`, `Models.swift`), which PR #118 (W3a tiles) rewrites; left for later.

## Sentry formats

- `Sentry.captureFeedback` (`@sentry/core` 10.x, read from the published package): an event with `type: "feedback"`, `level: "info"` and `contexts.feedback {message, contact_email, name, url, source, associated_event_id}`; the envelope item type is the event type, `feedback`. It goes through `scope.captureEvent`, so it carries the scope's breadcrumbs, user and trace context. The browser replay integration adds `contexts.feedback.replay_id`.
- `user_report` (legacy `captureUserFeedback`, sentry-cocoa `capture(userFeedback:)`): `{event_id, name, email, comments}` with no time, user or context; `event_id` names the error the user saw. The bridge remembers the event ids of the errors and messages it emitted (64 per session) to find the session (rule `event`).
- Verified on env `w6-feedback`: a `feedback` envelope matched by `device`, a `user_report` by `event`, both shown beside the session in the plugin.

## npm and npx in this worktree

- The shared main checkout's `package.json` breaks every npm command run from inside the worktree ("call config.load() before reading values", see [funnels.md](funnels.md)). `npm --prefix <dir>` works; `npx` does not take it. For `examples/ouo-mobile/scripts/build-ios.sh`, a shim named `npx` first on `PATH` that runs `$PWD/node_modules/.bin/$1` was enough to build and install the Release app.
- `ouo-env up` still needs the plugin built first and `git rev-parse HEAD` written to `plugins/ouo11y-rum-app/dist/.ouo-env-built`; that only skips when the plugin folder is committed (no dirty files).
