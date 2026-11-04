# Funnels

How many sessions go from one page or event to the next, in order, where they stop, and the
replays of those that stopped. Grafana -> More apps -> ouo11y RUM -> **Funnels**.

Rules: [specs/funnels.md](specs/funnels.md). Decision: [ADR-0012](adr/0012-funnel-reports.md).
API: [rum-api README, Funnels](../services/rum-api/README.md#funnels). A worked example with 50
generated sessions: [quickstart 5, tiny-shop-funnels](../examples/quickstarts/tiny-shop-funnels/README.md).

## What a step can be

| Step | Example | Comes from |
|---|---|---|
| **Page is** | `/checkout` | page loads and route changes the SDK records (`navigation`, `url.path`) |
| **Page starts with** | `/products/` | the same, any path with that prefix |
| **Event** | `add_to_cart` | `rum.addEvent("add_to_cart", {...})` in your app |

No app change is needed for page steps: `@ouo11y/browser` records every page load and every
`history.pushState` / `replaceState` / back-forward. For event steps, call `rum.addEvent` where
the action happens:

```js
rum.addEvent("add_to_cart", { "product.id": p.id });
rum.addEvent("order_paid", { "order.id": id, "order.total": total });
```

Name events after what happened, in `snake_case`, and keep the set small and stable: the name is
what the funnel matches, attributes are not (v1).

## Build one

1. Pick the time range (top right). Only events inside it count.
2. Set step 1 and step 2, then **Add step** for more (up to 10). The value box suggests the paths
   and custom event names seen in the range, most frequent first; type any other value and pick
   "Use this value". Arrows reorder, the bin removes.
3. Optional: **Completed within** (every step within that time of step 1), and **Platform**,
   **Environment**, **Release** (`service.version`) filters. The project and the app
   (`service.name`) come from the **Project** / **App** selector at the top, shared with the other
   pages ([scope spec](specs/rum-api-scope.md)).

The funnel is in the URL (`?step=page:/&step=page:/products/*&step=event:add_to_cart`): copy the
address bar to share it or bookmark it. There are no saved funnels in v1.

## Read it

- **The bar** is the sessions that reached the step; the big percentage is relative to step 1.
- **% of previous step** is the step's own conversion: the lowest one is the leak to fix first.
- **median · p75** is the time from the previous step for the sessions that made it. A long p75
  with an ordinary median means a slow minority: look at their replays.
- **sessions · users**: a funnel counts sessions; users are the distinct `user.id` of those
  sessions (one user with three sessions counts three times in sessions, once in users).
- **The hatched `−n`** above a bar is the sessions that reached the previous step and stopped.
  Click it for the list: when they entered, how long they took to get stuck, their last page, and
  **Replay** to open the session page with its replay, timeline, errors and traces.

## Counting rules, in short

- Steps must happen **in order within one session**. Other events in between do not matter; a
  repeated step counts once; a step done before the previous one does not count.
- A session that tries several times (home, product, home again, product, cart) is credited with
  its best attempt.
- A session whose step 1 happened before the start of the time range does not enter. Widen the
  range rather than shifting it.
- Sampling (`session.sampleRate`) scales every step down equally: percentages stay right, counts
  do not.

## Limits

2 to 10 steps, ranges up to 31 days, **Completed within** up to 7 days, 100,000 events read per
step kind (pages, events). A very busy app may need a narrower range or a filter. Results are
cached for 60 s (`loki.funnel_cache_ttl`).
