# 2026-10-24 Session lifecycle: user change, endSession, clearUser, device.id (N45)

Owner: sdk-browser (session B of N36, scope added by the orchestrator for the founder). Branch
`claude/web-sdk-session-lifecycle`, stacked on `claude/web-sdk-safety-209ff7` (N42, N43).

## Done

- **Rotate on user change** (`src/session/manager.ts`): `setUser` from one identified id to another
  ends the session with the new end reason `user_change` and starts a new one at once with
  `session.previous_id`; the `session.end` record carries the previous `user.id`, the new
  `session.start` the new one (the user switches between the two emits). Anonymous to identified
  (a login during the visit) keeps the session. `user.id` in the init options that differs from the
  resumed session's identified user rotates it the same way; with an anonymous resumed session it
  just sets the user.
- **`rum.endSession()`**: `session.end` with `manual`; the next activity or signal starts a new
  session (lazy, like `inactivity`). **`rum.clearUser()`** (logout): a fresh anonymous id, rotation
  with `user_change`.
- **`device.id`** (`src/session/device.ts`): random UUID under its own key `ouo.device`, apart from
  `ouo.session` and `ouo.user`, so it survives rotation, login and logout; memory fallback through
  `LocalStorage` when storage is blocked. On the OTel resource (once per export, not per record)
  and on `session.start` / `session.end`; `rum.session.deviceId()`. No IP or fingerprint linking.
- **rum-api**: `device_id` on the session record (list and detail; latest non-empty value, like
  `user_id`), `device_id` treated as an identifier (not a timeline attribute). End reasons were
  already passed through as strings in rum-api and the plugin, so `user_change` / `manual` need
  no change there.
- **Docs**: `docs/specs/session-lifecycle.md` (end reasons `user_change` and `manual`, a "User and
  device" section, `device.id` on the session events and `device_id` in the record, test cases
  8 to 10); SDK README "Sessions" (full lifecycle: start, activity, the four end reasons in a
  table, the anonymous-login rule, device id) and the API snippet; rum-api README.

## Verified, and how

- `npm run -w sdk/browser test`: 137 Vitest tests (21 files), including
  `test/session-users.test.ts` (11 cases: login keeps, switch rotates with the right users on end
  and start, same id no-op, logout, options user vs resumed session both ways, endSession and the
  linked next session, device id persistence / corrupt value / blocked storage) and
  `test/session-api.integration.test.ts` (the public API on the OTLP payloads: the seven session
  records in order with their users and reasons, `device.id` on each and on every resource).
- `go vet ./... && go test ./...` in `services/rum-api` (fixture `explicit_end_http_failed` now
  carries `device_id`).
- `size:check`: index.js 42.3 KB gzip (budget 44). `tsc` for the SDK and examples/ouo-web.
- Live, `ouo-env up web-sdk-session-lifecycle --src <this branch>` (PR #65's isolated ouo-env):
  a page with the built SDK in Chromium did login (alice), switch (bob), `clearUser`, `endSession`,
  one event. rum-api `/v1/sessions/<id>` for the four sessions: users alice, bob, anonymous,
  anonymous; `end_reason` `user_change`, `user_change`, `manual`, null (active); the same
  `device_id` on all four. Env torn down afterwards. A page fulfilled by `page.route` cannot reach
  the collector on localhost in Chromium (Local Network Access: "Permission was denied for this
  request to access the loopback address space"); serve test pages from a real local server.

## Left / next agent must know

- React Native SDK: no `device.id`, `endSession`, `clearUser` or `user_change` rotation yet; the spec
  marks `device.id` "when the SDK has one". A follow-up for `sdk/react-native` (install id under
  its storage) keeps the two SDKs aligned.
- The plugin shows `end_reason` as text already; it does not show `device_id` yet.
- Cross-tab: a user change in one tab rotates the shared session, and other tabs adopt the new
  session through the `storage` event; the `ouo.user` key itself is not synced live between tabs
  (unchanged from before).
