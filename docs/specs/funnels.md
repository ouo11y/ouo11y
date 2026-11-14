# Funnel reports specification

Status: normative. Changes require an ADR. Decided in [ADR-0012](../adr-archive/0012-funnel-reports.md); the reader moved to `ouo-go` and learnt the web SDK 0.4 wire in [ADR-0025 amendment 1](../adr/0025-generic-libs-clients-own-plugin-and-access.md#amendments).

A funnel answers "of the sessions that did step 1, how many then did step 2, then step 3...". `ouo-go` computes it (`Loki.Funnel`, `FunnelDropped`, `FunnelSteps`; rum-api did until it is deleted) from the session events already in Loki; nothing new is collected. User guide: [libs/ouo-go/funnels.md](../../libs/ouo-go/funnels.md).

## Steps

A funnel is an ordered list of **2 to 10 steps**. A step is one of:

| Kind | Matches | Source |
|---|---|---|
| `page`, match `exact` | a navigation whose path equals the value: a `browser.navigation` event's `url.full` path (web SDK 0.4 and later), or a `navigation` event's `url.path` (mobile SDKs, web SDK before 0.4) | page loads and route changes, screen changes on mobile |
| `page`, match `prefix` | a navigation whose path starts with the value | same; `/products/` matches `/products/7` |
| `event` | any event whose `event.name` equals the value, except `navigation` and `browser.navigation` | custom events, `recordEvent(name, attrs)` on the web and `rum.addEvent` on mobile (mobile marks them `ouo.event.custom = true`); built-in names such as `exception` match too |

A page value starts with `/`. Values are 1 to 256 characters, hold no control character, quote, backslash or backtick, and are compared case-sensitively. The path of `url.full` excludes its query and fragment. Click targets, query strings and attribute conditions are not steps in v1.

Compact form, used in URLs and `GET /v1/funnels/dropped`: `page:/cart`, `page:/products/*` (trailing `*` = prefix), `event:add_to_cart`.

## Counting

- **Unit: the session** (`session.id`). Each step reports the sessions that reached it and, alongside, the distinct users of those sessions (`enduser.id`, else `user.id`). Events without a `session.id` are ignored.
- **Strict order within one session.** A session reaches step *n* when it has a step-*n* event after (or at the same instant as) the event it used for step *n − 1*. Other events in between do not matter. A step repeated twice counts once. Events in the wrong order do not count: product page → home → add to cart reaches step 1 only for the funnel home → product → cart if no product page follows the home visit.
- **Several attempts.** Every occurrence of step 1 in the session is tried as a start; the deepest path wins, the earliest start on ties. A user who stalls, comes back to the home page later in the same session and buys is credited with the purchase.
- **Conversion window (optional, `within`).** When set, every step must be reached within `within` of the step-1 event of that attempt. 0 / absent: unbounded (the time range still bounds it). At most 7 days.
- Per step the report gives: sessions, users, conversion % from step 1 and from the previous step (two decimals), drop-off count (sessions that reached step *n − 1* but not *n*; 0 for step 1), and the median and p75 (nearest rank) of the time from step *n − 1* to step *n* over the sessions that reached step *n*.

## Time range and scoping

- Default the last 24 hours, at most **30 days** (every `ouo-go` read's limit; rum-api allowed 31 and rounded `from` / `to` down to 10 seconds for its cache). `ouo-go` does not cache: a caller that shows a report and its drop-off lists caches them itself.
- **Only events inside `[from, to]` are seen.** A session whose step 1 happened before `from` does not enter the funnel even if its later steps fall inside the range; a session that enters inside the range and converts after `to` is counted up to the last step reached by `to`. This keeps a funnel for a time range a statement about that range, and repeated queries over adjacent ranges do not count a session twice.
- Filters: `service` (`service.name`), `environment` (`deployment.environment.name`), `platform` (`ouo.platform`), `project` (`ouo.project.id`) are Loki stream labels; `release` (`service.version`) is structured metadata. All are exact matches; empty means any. Values match `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$` (project: the project id rule).

## Reading Loki

The reader runs **one query per step kind** in parallel, over `[from, to]`, with the filters in the selector:

- pages: `{…, event_name=~"navigation|browser[.]navigation"} | url_path=~"<alt>" or url_full=~"[^/]*//[^/]*(<alt>)([?#].*)?"` where `<alt>` is `<path 1>|<prefix 2>.*|…`; the path match is checked again in memory
- events: `{…, event_name=~"<name 1>|<name 2>|…"}`

and joins the results in memory per `session.id`. Each query is read in pages of 5,000 (`Loki.EventLimit`) up to 100,000 events (`Loki.FunnelEventLimit`); beyond that the funnel is computed on the first 100,000 events of that kind, undercounts the end of the range, and says `truncated`. Narrow the range or the filters for very busy apps.

Step suggestions count `url_path` of `navigation` and the path of `url_full` of `browser.navigation` events, and the event names marked `ouo.event.custom` or outside the SDKs' own names (`session.*`, `ouo.*`, `browser.*`, `app.*`, `device.*`, `exception`, `navigation`, `web_vital`, `http.request.failed`).

## API

`ouo-go`: `Loki.Funnel`, `Loki.FunnelDropped`, `Loki.FunnelSteps` ([README](../../libs/ouo-go/README.md)). rum-api, until it is deleted: `POST /v1/funnels/query`, `GET /v1/funnels/dropped`, `GET /v1/funnels/steps` ([README](../../services/rum-api/README.md#funnels)). A dropped session's replay is Muninn's answer (`Muninn.ListReplays`).

## Limits

| Limit | Value |
|---|---|
| steps | 2 to 10 |
| step value | 1 to 256 characters |
| `within` | 0 to 7 days |
| time range | at most 30 days (rum-api: 31) |
| events read per step kind | 100,000 |
| drop-off page size | default 50, at most 500 |
| step suggestions | 200 values per kind |
