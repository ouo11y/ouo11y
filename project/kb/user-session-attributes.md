# User and session attributes, OTA bundle id (F1, F2, 2026-11-04)

Spec: `docs/specs/attributes.md`. What was non-obvious while building it.

## Naming on the wire

- Each attribute is `ouo.attr.<key>`. Loki's OTLP ingestion rewrites `.` and `-` in attribute
  names to `_`, so it arrives as structured metadata `ouo_attr_<key>`. That is why keys are
  restricted to `^[A-Za-z][A-Za-z0-9_]{0,39}$`: with dots or dashes allowed, `a.b`, `a-b` and `a_b`
  would collide in Loki and rum-api could not tell them apart.
- `deploy/compose/loki/config.yaml` (and the Helm configmap) set `otlp_config` with
  `ignore_defaults: true` and a fixed index-label list, so `ouo.attr.*` and `ouo.app.bundle.*`
  are structured metadata without any config change. Never add them to that list.

## Filtering by attribute in rum-api

- The filter (`attr.<key>=<value>`, `bundle=`) runs on the folded record, not in LogQL. A LogQL
  `| ouo_attr_tenant="acme"` would keep only the events stamped after `setAttributes`: the
  `session.start` (emitted inside `initRUM`, before the app can call anything) would be dropped and
  the session would fold with a wrong `started_at` and counts. Same trap as the existing `user=`
  filter, which is a Loki filter and therefore only correct because `user.id` is on every record.
- So keys and values never reach LogQL; they are still validated (key rule, 128 characters, no
  control characters, at most 10 filters) and a bad one is a 400.
- Cost: the list folds every session of the window and filters after, like `status=`. The session
  index (web roadmap WB6) is what makes this cheap later.

## Fold rules

- Attributes: latest value per key over the session's events. A removed key keeps its last value
  (an event without the key cannot be told from one emitted before it was set).
- Bundle: **first** non-empty value, like `service_version`. A native crash of bundle A is reported
  at the next launch, which may already run bundle B (an OTA applied at restart, or a rollback):
  the React Native SDK does not stamp this run's attributes on records about a previous run's
  session id, but the resource still carries this run's bundle, so "latest" would move crashed
  sessions to the wrong bundle.

## Browser bundle size

- `mergeAttributes` + the stamp + the two methods cost about 0.42 KB gzip (44.16 to 44.58 KB).
  Dropping the init-time plumbing through `SessionManager` (apply `user.attributes` with one
  `setUser` right after `session.start()`) and one shared warning string saved 40 B. Budget
  raised 44.2 to 44.7 KB in the same PR (`sdk/browser/size-budget.json`).
- Measure with the worktree's own `node_modules`: `npm ci` from a nested worktree exits with
  "Exit prior to config file resolving" (kb `browser-delivery.md`); `npm --prefix "$PWD" ci`
  works. Before that, `npm run build` silently resolved tsup from the main checkout's stale
  `node_modules` two directories up and gave a different size.

## The user set and the user_change rotation (browser)

- The user's set lives in the persisted user record (`ouo.user` = `{ id, anonymous, attrs }`), so
  `saveUser` swaps id and set at the same instant. `switchUser` saves the user between the old
  session's `session.end` and the new `session.start`, so the end carries the old user's set and
  the start the new one's, with no extra code.
- React Native has no rotation on `setUser`; its user record is persisted after the cold-start
  read (not in the constructor any more), otherwise the constructor's write would replace the
  stored attributes of the same user before they were read.
