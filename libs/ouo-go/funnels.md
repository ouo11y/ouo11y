# Funnels with ouo-go

How many sessions go from one page or event to the next, in order, where they stop, and which
sessions stopped. Rules: [docs/specs/funnels.md](../../docs/specs/funnels.md). Decisions:
[ADR-0012](../../docs/adr-archive/0012-funnel-reports.md), [ADR-0025 amendment 1](../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md#amendments).
A worked example with 50 generated sessions: [quickstart 5, tiny-shop-funnels](../../examples/quickstarts/tiny-shop-funnels/README.md)
(it shows the MVP plugin's Funnels page, which these readers replace).

```go
loki := &ouogo.Loki{URL: "http://loki:3100"}
steps, err := ouogo.ParseFunnelSteps("page:/,page:/products/*,event:add_to_cart,event:order_paid")
q := ouogo.FunnelQuery{Steps: steps, Within: time.Hour, Filters: ouogo.Filters{Project: "shop"}}

report, err := loki.Funnel(ctx, q)                       // one row per step
stuck, err := loki.FunnelDropped(ctx, q, 3, 0, 50)       // reached step 2, not step 3
values, err := loki.FunnelSteps(ctx, q.Filters, q.TimeRange, "")  // for a step picker
```

## What a step can be

| Step | Compact form | Comes from |
|---|---|---|
| **Page is** | `page:/checkout` | page loads and route changes the SDKs record: `browser.navigation` (`url.full`) on the web since `@ouo11y/browser` 0.4.0, `navigation` (`url.path`) on mobile and older web SDKs |
| **Page starts with** | `page:/products/*` | the same, any path with that prefix |
| **Event** | `event:add_to_cart` | `recordEvent("add_to_cart", {...})` on the web, `rum.addEvent` on mobile |

No app change is needed for page steps: the web SDK records every page load and every History API
navigation. For event steps, record an event where the action happens:

```js
recordEvent("add_to_cart", { "product.id": p.id });
recordEvent("order_paid", { "order.id": id, "order.total": total });
```

Name events after what happened, in `snake_case`, and keep the set small and stable: the name is
what the funnel matches, attributes are not. The path of a page step is the URL path without its
query string or fragment.

`FunnelSteps` lists the paths and custom event names seen in the range, most frequent first (200
each at most), for a step builder's autocomplete; `ParseFunnelStep`, `ParseFunnelSteps` and
`FunnelStep.String` read and write the compact form, which fits a URL for sharing a funnel.

## Read a report

- **`Sessions`** of a step is the sessions that reached it; **`ConversionFromFirst`** is relative to
  step 1.
- **`ConversionFromPrevious`** is the step's own conversion: the lowest one is the leak to fix first.
- **`MedianMs` · `P75Ms`** is the time from the previous step for the sessions that made it. A long
  p75 with an ordinary median means a slow minority: look at their replays.
- **`Users`** are the distinct users of those sessions (`enduser.id`, else `user.id`; one user with
  three sessions counts three times in sessions, once in users).
- **`DroppedOff`** is the sessions that reached the previous step and stopped. `FunnelDropped` lists
  them, latest first: when they entered, when they reached their last step, their last page. Ask
  `Muninn.ListReplays` for a dropped session's replay.
- **`Truncated`**: a step query read 100,000 events (`Loki.FunnelEventLimit`) and stopped; the end of
  the range is undercounted.

## Counting rules, in short

- Steps must happen **in order within one session**. Other events in between do not matter; a
  repeated step counts once; a step done before the previous one does not count.
- A session that tries several times (home, product, home again, product, cart) is credited with
  its best attempt.
- A session whose step 1 happened before the start of the time range does not enter. Widen the
  range rather than shifting it.
- **`Within`** (optional) requires every step within that time of step 1.
- **Filters** (`Filters`: project, service, environment, release, platform) are exact matches. `Platform` matches the `ouo_platform` label, which web SDK 0.4 sessions do not carry: a funnel filtered by platform leaves them out, so leave `Platform` empty to count the web, or filter by `Service`.
- Sampling scales every step down equally: percentages stay right, counts do not.

## Limits

2 to 10 steps, ranges up to 30 days (default the last 24 hours), `Within` up to 7 days, 100,000
events read per step kind (pages, events), drop-off pages of 50 by default and 500 at most. Nothing
is cached: a caller that shows a report and then its drop-off lists can cache the answers itself.
A bad step, filter or range is a `*BadRequestError` and nothing is sent to Loki.

## Compared with rum-api

The readers port rum-api's `internal/funnel` and its tests. What differs, and why:

| | rum-api | ouo-go |
|---|---|---|
| Page steps on the web | `navigation` with `url.path` only: since `@ouo11y/browser` 0.4.0 (`browser.navigation` with `url.full`) every web page step counts 0 sessions | both wires |
| Users | `user.id` only, which the web SDK no longer sends | `enduser.id`, else `user.id` |
| Custom event suggestions | marked `ouo.event.custom`, which the web SDK no longer sends | marked, or any name outside the SDKs' own |
| Range | 31 days, rounded to 10 s, cached 60 s | 30 days like every ouo-go read, as given, not cached |
| Dropped sessions' replay | `has_replay` from rum-api's replay store | ask Muninn |
| Truncation at 100,000 events | silent | `Truncated` |
| Store errors | the Loki error text in the answer (`/v1/funnels/steps`) | `*BackendError`; `Public()` names the store only |
| Step values and filters | quoted into LogQL | checked first (no control characters, quotes, backslashes, backticks; filters `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`), then quoted |
