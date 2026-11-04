# ADR-0019 Funnel step conditions, a failed outcome per step, and a truncated flag

Status: proposed (2026-11-04). Amends [ADR-0012](0012-funnel-reports.md).

## Context

ADR-0012 shipped funnels whose steps are a page path or an event name, and said that attribute conditions "are not steps in v1; they need their own ADR". A client, JUHI, runs payment journeys through ouo and needs two things the v1 funnel cannot give:

1. **Conditional steps.** One event name covers several journeys: `checkout.submit` is sent for card, wallet and bank-transfer payments, with the method in an attribute (`payment.method`). JUHI wants the card funnel only: `event checkout.submit where payment.method = card`.
2. **Failure, not just drop-off.** A drop-off today mixes users who walked away with users the app failed. For a payment journey these are different problems with different owners. JUHI wants, per step, how many sessions stopped because something broke, and those sessions' replays.

A third gap came up while reading the code: each Loki read of a funnel stops at the client's cap of 100,000 events (5,000 per page × 20 pages). ADR-0012 recorded the cap but the response says nothing when it is hit, so a busy app's funnel silently undercounts the end of the range.

The events already carry what is needed. Custom events (`rum.addEvent(name, attrs)`) and exceptions arrive in Loki with their attributes as **structured metadata** (`payment.method` becomes `payment_method`), next to `session.id`. Exceptions are `event_name="exception"` records of the same session.

Options considered for conditions:

1. **Filter in memory only.** Read every event of the step's name and drop the ones that fail the condition in rum-api. Simple, but it reads (and caps at 100,000) events the funnel throws away: a card funnel on a wallet-heavy app spends its cap on wallet events.
2. **LogQL label filters on structured metadata** (`| payment_method="card"`). Loki applies them per line on the streams the event-name selector already chose, without a parser stage (no `| json`, no `| logfmt`); only matching lines come back. This is the cheapest filter LogQL has after the stream selector.
3. **Stream labels per attribute.** Fast to select, but turning arbitrary custom attributes into labels is a cardinality problem ADR-0002 and ADR-0012 already ruled out.

Options considered for "failed":

1. **A new step kind** (`failure:exception`). It would make failure a position in the funnel, but a failure can happen between any two steps and is not something a user "reaches".
2. **An outcome computed in the engine.** The walk already knows, per session, the last step reached and when. Looking for a failure event after that point is one more pass over the session's events in memory.

## Decision

1. **Event steps take `where` conditions** (option 2). A condition is `key op value`; all of a step's conditions must hold (and). Operators:
   - `=` and `!=`: exact string comparison. A missing attribute reads as the empty string, as in LogQL, so `key!=""` means "the attribute is set".
   - `=~`: an RE2 regular expression, fully anchored as Loki anchors it. It stays cheap enough: it runs only on the lines the selector already narrowed to the step's event name, RE2 matches in linear time, and the expression is at most 256 bytes.
   - No `!~`, no numeric comparison (`>`, `<`): nothing has asked for them, and numeric comparison needs a typed-value story the API does not have.
   - At most 5 conditions per step. Page steps take no conditions in this ADR. Their paths already narrow them, and adding conditions there would need the same work on the navigation query for no request.
2. **Translation to LogQL.** A step's key is the OpenTelemetry attribute name as sent (`payment.method`); rum-api maps it to the Loki name by replacing every character outside `[A-Za-z0-9_]` with `_` (`payment_method`), as Loki's OTLP ingest does. The events query stays one query for all event steps:
   - The selector names every step event as today (`event_name=~"a|b"`).
   - When at least one event name only appears with conditions, one label-filter expression follows. It has one alternative per name: the bare `event_name="…"` for names that also appear without conditions, and the name and its condition sets for the others. Every operand is parenthesised, so LogQL's `and` / `or` precedence never matters.
   - The engine re-checks every condition in memory, because one query serves several steps. The in-memory check reads the same keys the same way (missing = "").
3. **Injection.** Conditions are user input that ends up in LogQL, so:
   - A key must match `[A-Za-z_][A-Za-z0-9_.-]*` and be at most 128 bytes. After the mapping it is `[A-Za-z0-9_]` only, so it can never close a string or a brace.
   - `event.name` is refused: the step value is the event name. So are SDK constants rum-api drops on read (`telemetry.sdk.*` and the like), which the in-memory check could not see.
   - A value must be valid UTF-8 without control characters, at most 256 bytes. It is rendered as a Go-quoted string literal, which LogQL reads with the same escapes. A `"` or `\` in a value stays inside the literal.
   - Event names get the same printable-UTF-8 check. They were already quoted (and regex-escaped in the selector).
   - Tests feed hostile keys, values and names through the API and assert that each query has one selector and balanced literals.
4. **Failed outcome** (option 2), computed in the in-memory engine. For each session, take the attempt the walk credits (deepest, earliest start on ties; ADR-0012). The session **failed** when:
   - it stopped before the last step;
   - a **failure event** happened at or after the event of the last step it reached (that event itself excepted);
   - with a conversion window, the failure event falls within it of step 1;
   - everything happened in the same session, inside the range.

   The failure event is `exception` by default. A query can name another event with its own conditions (`payment.failed where reason=declined`) or turn failure tracking off. It is fetched by one more Loki query of the same shape, only when tracking is on.
5. **Where failed shows.** It follows the row convention of `dropped_off`: the row of step *n* counts the sessions that reached step *n − 1* but not *n*. So "an attempt at step *n − 1* followed by a failure event before step *n*" is a **failed** count on row *n*. It is part of `dropped_off`; the rest is abandoned. `failure_rate` is failed as a percentage of step *n − 1*'s sessions: of those who tried to go on, how many the app failed. The drop-off list takes `outcome=failed|abandoned`, and each row carries the outcome, the failure time, the failure event name and the first 300 characters of its log line, next to the replay link it already had. A session that hit an exception and still converted is not failed. Its outcome at that step is "converted". Counting recoveries is a possible follow-up.
6. **Truncation: a flag, not a bigger cap.**
   - Raising the cap moves the cliff without removing it, and makes the worst-case request heavier for Loki and rum-api's memory.
   - Instead, the Loki client reports when a read ended on a full last page with no page left. The response then carries:
     - `truncated: true`;
     - the reads that were cut (`pages`, `events`, `failures`);
     - the cap (`events_read_limit`);
     - `complete_until`, the earliest last-event time of the cut reads: the funnel saw every event up to there.
   - The plugin shows a warning with that time.
   - A read that ends exactly on a full last page is reported as truncated even if nothing followed. That is a deliberate false positive over a silent undercount.

## Consequences

- JUHI's card funnel is one URL: `?step=event:cart.view&step=event:checkout.submit where payment.method=card&step=event:payment.success`. Failed and abandoned are split per step, with replays one click away. There is still no ingest change and no new component.
- The compact step form grows a ` where ` clause (`event:checkout.submit where payment.method=card and note="two words"`). An event name containing ` where ` can no longer be used. A bare value is a token without spaces; any other value is Go-quoted.
- Query cost:
  - A conditional step makes the events query cheaper, because fewer lines come back.
  - Failure tracking adds one query per funnel, over the failure event in the range. On an app throwing many exceptions that read can itself be truncated, and is reported as such.
- The default failure event is the session's exceptions. Only exceptions after the last reached step count, but one from an unrelated part of the app can still mark a session failed. Narrowing it is the query's job (`failure=event:exception where exception.type=PaymentError`, or a dedicated `payment.failed` event).
- Still not done and still each needs an ADR:
  - conditions on page steps;
  - numeric operators;
  - saved funnels;
  - per-user funnels;
  - counting sessions that recovered after a failure.
