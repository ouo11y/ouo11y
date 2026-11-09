# Questions Step 2 hands to Step 3 (the SDK spec)

Step 2 decided names and signal types, in [rules.md](rules.md) and the entries it links. These are left for the spec.

## Waiting on the founder

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Do OTel SDK names with no registry entry stay unprefixed? | Yes |
| D2 | Page load as both a `browser.navigation` event and a `documentLoad` span? | Yes, only with the server link |
| D3 | Replay: bytes to the Collector, reference onward? | Yes |
| D4 | Keep `service.instance.id`, `app.installation.id` and `device.id` off the resource, and `session.id` in baggage off by default? | Yes |
| D5 | Add `ouo.view.id` on every record? | Yes |

## For the spec

1. Session timeouts, and what counts as activity. The OTel browser's definition counts any telemetry. Do we count only user input?
2. Sessions across tabs. OTel shares one per origin. Do we also need a per-tab id, separate from `ouo.view.id`?
3. Which errors bypass session sampling, and how.
4. Which attributes are opt-in for privacy: selectors, widget names, INP target, URLs. Sanitising defaults.
5. Replay chunk size and flush timing, within the shared 64 KiB unload budget.
6. Does the SDK estimate clock offset, or only the edge?
7. What we call the first-display signal on mobile, if we want one.
8. Viewport size for heatmaps: on the click or on the view.
9. Export encoding per signal, and whether replay is protobuf only.
10. The manual API: custom soft navigation, screen names, setting `ouo.exception.fingerprint`.
11. React Native boundaries: which signals JS emits and which the native layer emits, so nothing doubles. OTel offers no guidance.
12. How a `session.id` is restored after a crash, so that the replayed `app.crash` has the right one.

## To verify later

- `signaltometrics` as the single writer for web vitals: exponential histogram output, and behaviour across Collector replicas.
- The Collector copy of `EventName` to `otel.event.name` end to end on Loki.
- Replay reference flow through a real Collector component.

## Watch list

Check these before implementing.

| Item | Why |
|---|---|
| Client-side #34, #35 | Decisions and INP names |
| Client-side PR #48, #51, core #4306, #4308 | `session`, `app`, `device` schema URL move |
| Browser PR #504 | `documentLoad` |
| Browser PR #429, #486, #551 | Long frames, INP attributes, error location |
| Browser issues #84, #510, #535 | View id, frustration, session in baggage |
