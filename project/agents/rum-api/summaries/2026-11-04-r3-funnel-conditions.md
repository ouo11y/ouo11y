# 2026-11-04 R3: funnel step conditions, failed outcome, truncated flag (JUHI)

Branch `claude/r3-funnels`. Decision: [ADR-0019](../../../../docs/adr/0019-funnel-step-conditions-and-failed-outcome.md) (amends ADR-0012). Spec: [docs/specs/funnels.md](../../../../docs/specs/funnels.md).

## Done

- **rum-api, `internal/funnel`.**
  - `condition.go`: conditions on event steps and on the failure event, with operators `=`, `!=` and `=~`.
  - Keys map to Loki names. Keys and values are validated against LogQL injection, and values are rendered with `strconv.Quote`.
  - Compact form: `event:x where k=v and k2="a b"`.
  - `Walk` marks a stopped session **failed** when a failure event follows the event of the last step it reached.
  - `Report` adds `failed` and `failure_rate` per row; `Dropped` takes an outcome.
- **rum-api, `internal/session`.** `Event.Value(key)` reads any retained label; `Retained(key)` tells which keys rum-api keeps.
- **rum-api, `internal/loki`.** `EventsQueryCapped` reports a read cut at `PageLimit × MaxPages`; `ReadLimit()` returns that cap.
- **rum-api, `internal/httpapi/funnels.go`.**
  - The events query gets one label-filter expression for conditional names.
  - A third read covers the failure event.
  - `failure` in the body (`{event, where}` or `{off:true}`) and in GET (`event:… where …` or `off`).
  - `outcome=failed|abandoned` on `/v1/funnels/dropped`, plus per-session `outcome`, `failed_at`, `failure_event` and `failure_message`.
  - Responses carry `truncated`, `truncated_reads`, `events_read_limit` and `complete_until`.
- **Plugin.**
  - `ConditionEditor` (Where… / And…, attribute, operator, value; commits on blur or Enter).
  - Failure event summary with "Change failure event" (Combobox and conditions, mounted on demand).
  - `FunnelChart`: failed share at the foot of the drop-off, plus "n failed · x% failure rate" that opens the failed list.
  - `DroppedSessions`: All / Failed / Abandoned switch, outcome column with the failure event, time and message, and the replay button.
  - A "Partial funnel" warning when truncated.
  - The URL keeps `step=event:… where …`, `failure` and `outcome`.
- **Docs.**
  - ADR-0019, with the ADR index and ADR-0012's status line updated.
  - Spec rewritten for conditions, failure, outcome and cap.
  - rum-api README Funnels section.
  - `docs/funnels.md` user guide.
  - kb `project/kb/funnels.md` section "Step conditions and the failed outcome".
- No new dependency.

## Verified

- `go test ./...` and `go vet ./...` in `services/rum-api` pass. New tests:
  - `internal/funnel/condition_test.go`: validation, injection literals, matching, the compact form, walk conditions, failure attribution in 10 cases, report and outcome.
  - `internal/httpapi/funnels_conditions_test.go`: conditions and failed end to end, named and off failure events, truncation, injection through the API, the shape of the events filter.
  - `internal/loki`: `TestEventsQueryCapped`.
- Plugin: `tsc --noEmit`, eslint on the changed files, and Jest `src/pages/Funnels.test.tsx` and `src/utils/funnel.test.ts`.
  - New cases: conditional steps sent and shown, a condition written on blur, the failed count opening the failed list, the failed list with message and replay, the failure event editor on demand, the truncation warning, failure off.
  - The #153 fix in `jest-setup.js` is untouched.
- **Live**, on compose project `r3funnels` (ports 25300-25310) with rum-api built from this branch:
  - 33 payment sessions went through the collector (`scripts/r3-funnel-journeys.mjs`, run `a`).
  - Funnel `cart.view → checkout.submit where payment.method=card → payment.success`: 33 / 22 / 10, failed 3 (9.09 %) and 6 (27.27 %), exactly the generator's personas.
  - `!=paypal` gives 23, `=~"card|paypal"` 27, `!=""` 28.
  - The hostile value `card" or x="y` matches only its own session, and Loki accepted the query.
  - The named failure event `payment.failed where reason=declined` gives 2; failure off gives 0; a hostile key returns 400.
  - The dropped lists for failed, abandoned and all return 6 / 6 / 12, with messages.
  - Grafana page: see the PR body.

## Left / next agent

- Truncation was verified with unit tests (fake Loki pagination) only. Producing more than 100,000 live events was out of budget.
- Not done (ADR-0019 "still not done"): conditions on page steps, numeric operators, recovered sessions, and suggestions for attribute keys in the condition editor (would need Loki `detected_fields`).
- PR #162 (R1 project selector) touches `Funnels.tsx` (ScopePicker, `TEXT_FILTERS`) and `docs/funnels.md`. Expect a small merge in those hunks.
