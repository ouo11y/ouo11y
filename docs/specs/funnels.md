# Funnel reports specification

Status: normative. Changes require an ADR. Decided in [ADR-0012](../adr-archive/0012-funnel-reports.md).

A funnel answers "of the sessions that did step 1, how many then did step 2, then step 3...". rum-api computes it from the session events already in Loki; nothing new is collected.

## Steps

A funnel is an ordered list of **2 to 10 steps**. A step is one of:

| Kind | Matches | Source |
|---|---|---|
| `page`, match `exact` | a `navigation` event whose `url.path` equals the value | page loads and route changes of the browser SDK (`event.name = navigation`, `ouo.navigation.kind` load / push / replace / pop) |
| `page`, match `prefix` | a `navigation` event whose `url.path` starts with the value | same; `/products/` matches `/products/7` |
| `event` | any event whose `event.name` equals the value, except `navigation` | custom events, `rum.addEvent(name, attrs)` (they carry `ouo.event.custom = true`); built-in names such as `exception` match too |

A page value starts with `/`. Values are 1 to 256 characters and are compared case-sensitively. Click targets, query strings and attribute conditions are not steps in v1.

Compact form, used in URLs and `GET /v1/funnels/dropped`: `page:/cart`, `page:/products/*` (trailing `*` = prefix), `event:add_to_cart`.

## Counting

- **Unit: the session** (`session.id`). Each step reports the sessions that reached it and, alongside, the distinct `user.id` of those sessions. Events without a `session.id` are ignored.
- **Strict order within one session.** A session reaches step *n* when it has a step-*n* event after (or at the same instant as) the event it used for step *n − 1*. Other events in between do not matter. A step repeated twice counts once. Events in the wrong order do not count: product page → home → add to cart reaches step 1 only for the funnel home → product → cart if no product page follows the home visit.
- **Several attempts.** Every occurrence of step 1 in the session is tried as a start; the deepest path wins, the earliest start on ties. A user who stalls, comes back to the home page later in the same session and buys is credited with the purchase.
- **Conversion window (optional, `within`).** When set, every step must be reached within `within` of the step-1 event of that attempt. 0 / absent: unbounded (the time range still bounds it). At most 7 days.
- Per step the report gives: sessions, users, conversion % from step 1 and from the previous step (two decimals), drop-off count (sessions that reached step *n − 1* but not *n*; 0 for step 1), and the median and p75 (nearest rank) of the time from step *n − 1* to step *n* over the sessions that reached step *n*.

## Time range and scoping

- `from` / `to` take the same forms as the rest of the API (RFC 3339, Unix s / ms, `now-24h`); default the last 24 hours, at most **31 days**. Both are rounded down to 10 seconds so relative ranges share a cache entry.
- **Only events inside `[from, to]` are seen.** A session whose step 1 happened before `from` does not enter the funnel even if its later steps fall inside the range; a session that enters inside the range and converts after `to` is counted up to the last step reached by `to`. This keeps a funnel for a time range a statement about that range, and repeated queries over adjacent ranges do not count a session twice.
- Filters: `service` (`service.name`), `environment` (`deployment.environment.name`), `platform` (`ouo.platform`), `project` (`ouo.project.id`) are Loki stream labels; `release` (`service.version`) is structured metadata. All are exact matches; empty means any.

## Reading Loki

rum-api runs **one query per step kind** in parallel, over `[from, to]`, with the filters in the selector:

- pages: `{…, event_name="navigation"} | url_path=~"<path 1>|<prefix 2>.*|…"`
- events: `{…, event_name=~"<name 1>|<name 2>|…"}`

and joins the results in memory per `session.id`. A query returns at most the Loki client's page limit × page count (5,000 × 20 = 100,000 events); beyond that the funnel is computed on the first 100,000 events of that kind and undercounts the end of the range. Narrow the range or the filters for very busy apps.

Results are cached per (steps, within, filters, from, to) for `loki.funnel_cache_ttl` (default 60 s), so a report and the drop-off lists clicked from it share one Loki read.

## API

See [services/rum-api/README.md](../../services/rum-api/README.md#funnels): `POST /v1/funnels/query`, `GET /v1/funnels/dropped`, `GET /v1/funnels/steps`. All three need the read token when one is configured.

## Limits

| Limit | Value |
|---|---|
| steps | 2 to 10 |
| step value | 1 to 256 characters |
| `within` | 0 to 7 days |
| time range | at most 31 days |
| events read per step kind | 100,000 |
| drop-off page size | default 50, at most 500 |
| step suggestions | 200 values per kind |
