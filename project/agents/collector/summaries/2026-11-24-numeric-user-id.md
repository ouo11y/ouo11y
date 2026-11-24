# 2026-11-24: numeric `user.id` no longer drops the event

## What was wrong

`sentryUser.ID` was a Go `string`. A browser app that calls `Sentry.setUser({ id: user.id })`
with a numeric database id sends `"user":{"id":69}`. Relay accepts that (it stores `"69"`), but
the bridge's `json.Unmarshal` into `sentryEvent` failed, so `decode()` counted the item
`ouo_sentry_items_total{type="event", translated="false"}` and dropped it. No
`translate_dropped` reason and no log line above Debug. Every error sent after login was lost;
only errors sent before `setUser` (no user) were translated.

Found on a production bridge (collector 0.6.0, `@sentry/react` 7.58.1, mirror-fed): over 24 h,
229 error events received for the web project, 7 translated. The mobile project (string ids) had
all of its events translated.

## What changed

- `sentry.go`: `sentryUser.ID` is a `lenientString`: a JSON string, number or boolean. A number
  is kept as written (`json.Number`, no float64 round trip), so a 64-bit id stays exact. Any other
  shape (object, array, null) becomes `""` and never fails the event. The six readers convert
  with `string(...)`. Replay events share the type, so a numeric id there is fixed too.
- `docs/specs/sentry-bridge.md`: the `user.id` row says which shapes are accepted.

## Verified

- `TestNumericUserIDTranslates`: one envelope with four browser `AbortError` events, user ids
  `69`, `9007199254740993`, `"abc"` and an object. On collector 0.6.0 the same test gets 1 record
  of 4 (only the string id); with the fix, 4 records with `user.id` = `"69"`,
  `"9007199254740993"`, `"abc"` and none.
- `TestLenientString`: the decoder on each JSON shape.
- `go vet` clean, `go test -race -count=1 ./...` in `collector/receiver/ouosentryreceiver` passes.

## Left

- Release a collector patch (release-please) so the production bridge can bump its pin.
- Other fields that are typed narrower than Relay's schema have not been audited.
