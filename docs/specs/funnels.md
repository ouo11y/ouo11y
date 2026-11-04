# Funnel reports specification

Status: normative. Changes require an ADR. Decided in [ADR-0012](../adr/0012-funnel-reports.md), amended by [ADR-0019](../adr/0019-funnel-step-conditions-and-failed-outcome.md) (step conditions, failed outcome, truncated flag).

A funnel answers "of the sessions that did step 1, how many then did step 2, then step 3...", and, of those that stopped, how many stopped because the app failed. rum-api computes it from the session events already in Loki; nothing new is collected.

## Steps

A funnel is an ordered list of **2 to 10 steps**. A step is one of:

| Kind | Matches | Source |
|---|---|---|
| `page`, match `exact` | a `navigation` event whose `url.path` equals the value | page loads and route changes of the browser SDK (`event.name = navigation`, `ouo.navigation.kind` load / push / replace / pop) |
| `page`, match `prefix` | a `navigation` event whose `url.path` starts with the value | same; `/products/` matches `/products/7` |
| `event` | any event whose `event.name` equals the value, except `navigation`, and that satisfies every condition of the step | custom events, `rum.addEvent(name, attrs)` (they carry `ouo.event.custom = true`); built-in names such as `exception` match too |

A page value starts with `/`. Values are 1 to 256 characters of printable UTF-8 and are compared case-sensitively. Click targets and query strings are not steps.

### Conditions

An event step takes up to **5 conditions** (`where`), all of which must hold:

| Operator | Holds when |
|---|---|
| `=` | the attribute equals the value |
| `!=` | the attribute differs from the value |
| `=~` | the attribute matches the value as an RE2 regular expression, fully anchored (`5..` matches `503`, not `1503`) |

- The **key** is the OpenTelemetry attribute name as the SDK sends it (`payment.method`): it starts with a letter or `_`, then letters, digits, `_`, `.` or `-`; at most 128 bytes. It is compared under its Loki name, every other character replaced by `_` (`payment_method`), so `payment.method` and `payment_method` are the same key.
- Event attributes, resource attributes rum-api keeps (device, OS, build, environment) and the identifiers (`user.id`, `service.version`, `ouo.platform`…) can be used. `event.name` cannot (it is the step value), nor SDK constants rum-api drops (`telemetry.sdk.*`, `browser.*`, `user_agent.original`…).
- The **value** is a string of printable UTF-8, at most 256 bytes (non-empty for `=~`). Comparison is on the string Loki stores: `amount=10` does not match `10.0`.
- A **missing attribute** reads as the empty string: `coupon=""` holds when there is no `coupon`, `coupon!=""` when there is one.
- Page steps take no conditions.

### Compact form

The compact form is used in URLs and in the `GET` endpoints' `steps` and `failure` parameters:

- `page:/cart`
- `page:/products/*` (a trailing `*` makes it a prefix match)
- `event:add_to_cart`
- `event:checkout.submit where payment.method=card and amount!=0 and plan=~"pro|team"`

The first ` where ` starts the conditions; they are joined by ` and `. A value is either a bare token (letters, digits, `_ . : / @ + -`) or a Go-quoted string (`note="two words"`, `reason="a \"quoted\" value"`). An event name cannot contain ` where `.

## Failure event

The **failure event** marks sessions that stopped because something broke. By default it is `exception` (any exception of the session). A query can:

- name another event with its own conditions, such as `payment.failed where reason=declined`, or `exception where exception.type=PaymentError`;
- turn failure tracking off.

The failure event follows the same rules as an event step (name, up to 5 conditions).

## Counting

- **Unit: the session** (`session.id`). Each step reports the sessions that reached it and, alongside, the distinct `user.id` of those sessions. Events without a `session.id` are ignored.
- **Strict order within one session.** A session reaches step *n* when it has a step-*n* event after (or at the same instant as) the event it used for step *n − 1*. Other events in between do not matter. A step repeated twice counts once. Events in the wrong order do not count: product page → home → add to cart reaches step 1 only for the funnel home → product → cart if no product page follows the home visit.
- **Several attempts.** Every occurrence of step 1 in the session is tried as a start; the deepest path wins, the earliest start on ties. A user who stalls, comes back to the home page later in the same session and buys is credited with the purchase.
- **Conversion window (optional, `within`).** When set, every step must be reached within `within` of the step-1 event of that attempt. 0 / absent: unbounded (the time range still bounds it). At most 7 days.
- **Outcome of a session that stopped.** A session that reached step *n − 1* but not step *n* (on the credited attempt) has one of two outcomes:
  - **failed**: a failure event happened at or after the event it used for step *n − 1* (that event itself excepted), in the same session, inside the range, and within the window of step 1 when one is set;
  - **abandoned**: any other case.

  A session that hit the failure event and still reached step *n* is not failed.
- Per step the report gives:
  - sessions and users;
  - conversion % from step 1 and from the previous step (two decimals);
  - **drop-off**: sessions that reached step *n − 1* but not *n*; 0 for step 1;
  - **failed**: the part of the drop-off whose outcome is failed;
  - **failure rate**: failed as a percentage of step *n − 1*'s sessions, two decimals;
  - the median and p75 (nearest rank) of the time from step *n − 1* to step *n*, over the sessions that reached step *n*.

  For step 1, failed and the failure rate are 0. A failure that follows step *n − 1* is reported on step *n*'s row, the step the session failed to reach.

## Time range and scoping

- `from` / `to` take the same forms as the rest of the API (RFC 3339, Unix s / ms, `now-24h`); default the last 24 hours, at most **31 days**. Both are rounded down to 10 seconds so relative ranges share a cache entry.
- **Only events inside `[from, to]` are seen.** A session whose step 1 happened before `from` does not enter the funnel even if its later steps fall inside the range; a session that enters inside the range and converts after `to` is counted up to the last step reached by `to`. This keeps a funnel for a time range a statement about that range, and repeated queries over adjacent ranges do not count a session twice. Failure events after `to` are not seen either.
- Filters: `service` (`service.name`), `environment` (`deployment.environment.name`), `platform` (`ouo.platform`), `project` (`ouo.project.id`) are Loki stream labels; `release` (`service.version`) is structured metadata. All are exact matches; empty means any.

## Reading Loki

rum-api runs **one query per kind of read** in parallel, over `[from, to]`, with the filters in the selector:

- pages: `{…, event_name="navigation"} | url_path=~"<path 1>|<prefix 2>.*|…"`
- events: `{…, event_name=~"<name 1>|<name 2>|…"}`, followed by a label filter when an event name only appears with conditions:
  `| (event_name="cart.view") or (event_name="checkout.submit" and ((payment_method="card")))`. With a single event name the name test is left out: `| payment_method="card"`.
- failures (unless off): `{…, event_name="<failure event>"}`, plus ` | <conditions>` when it has any.

The results are joined in memory per `session.id`, and every condition is checked again there, because one events query serves several steps. Condition keys are reduced to `[A-Za-z0-9_]` and values are Go-quoted string literals, so user input cannot leave its literal (ADR-0019).

**Cap.** One read returns at most the Loki client's page limit × page count: 5,000 × 20 = 100,000 events. Beyond that, the funnel is computed on the first 100,000 events of that read and undercounts the end of the range. The response then says so:

- `truncated: true`;
- `truncated_reads` lists the cut reads (`pages`, `events`, `failures`);
- `events_read_limit` is the cap;
- `complete_until` is the earliest last-event time of the cut reads: every event up to that time was seen.

A read that ends exactly on a full last page counts as truncated. Narrow the range, the filters or the conditions.

Results are cached per (steps, within, failure event, filters, from, to) for `loki.funnel_cache_ttl` (default 60 s), so a report and the drop-off lists clicked from it share one Loki read.

## API

See [services/rum-api/README.md](../../services/rum-api/README.md#funnels): `POST /v1/funnels/query`, `GET /v1/funnels/dropped` (with `outcome=failed|abandoned`), `GET /v1/funnels/steps`. All three need the read token when one is configured.

## Limits

| Limit | Value |
|---|---|
| steps | 2 to 10 |
| step value | 1 to 256 characters |
| conditions per step (and on the failure event) | 0 to 5 |
| condition key | 1 to 128 bytes, `[A-Za-z_][A-Za-z0-9_.-]*` |
| condition value | 0 to 256 bytes (1 to 256 for `=~`), printable UTF-8 |
| `within` | 0 to 7 days |
| time range | at most 31 days |
| events read per read (pages, events, failures) | 100,000, flagged when reached |
| failure message kept per dropped session | 300 characters |
| drop-off page size | default 50, at most 500 |
| step suggestions | 200 values per kind |
