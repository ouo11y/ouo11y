# F1 / F2 (client JUHI): user and session attributes, OTA bundle id (2026-11-04)

PR https://github.com/ouo11y/ouo11y/pull/166, branch `claude/f1f2-attributes`. Spec
`docs/specs/attributes.md`, kb `project/kb/user-session-attributes.md`. Covers web roadmap WB7's
`rum.setAttributes` item.

## Done

- **SDKs** (browser, React Native, native iOS): `setUser({ id, attributes })`, `setAttributes`,
  `removeAttribute`.
  - Keys `^[A-Za-z][A-Za-z0-9_]{0,39}$`; values are primitives, strings cut to 128; at most 20 keys
    in both sets.
  - Stamped as `ouo.attr.<key>` on every later span and log record.
  - The user set is persisted with the user and swapped at a `user_change` rotation.
  - The app set is in memory and wins on a clash.
  - iOS was built by a delegated sub-agent: `CustomAttributes.swift`, the user set in
    `session.json`, 16 tests in `AttributesTests`, and ObjC selectors.
- **React Native F2**: a `bundle: { id, channel? }` option and `rum.setBundle()`, which add
  `ouo.app.bundle.*` to the resource and to every signal.
  - Previous-run records are not stamped with this run's attributes or bundle.
  - Native iOS: not applicable (spec section 5).
- **rum-api**:
  - The record gains `attributes` (latest value per key) and `bundle_id` / `bundle_channel`
    (first value).
  - `attr.<key>=` and `bundle=` filter on the folded record (never LogQL) and are validated
    with 400s.
  - Health buckets are per version × bundle.
- **Plugin**:
  - Sessions page: Bundle and Attribute (`key=value`) filters with removable chips.
  - Session page: Bundle and Attributes rows, each attribute linking to its sessions.
  - Overview: a Bundle column.
- **Examples**:
  - `ouo-web` sets `tenant`, `storefront` and a per-user `plan`.
  - `ouo-mobile` sets `tenant`, a per-user `plan`, and a bundle from `EXPO_PUBLIC_OUO_BUNDLE_ID`.
- **Test fix**: the browser rage-click test waits out the previous test's burst window. It
  failed on main too whenever `settle()` finished early.

## Budget decision

The browser core goes from 44.16 to 44.58 KB gzip (+0.42 KB, after trimming 40 B), and
`size-budget.json` goes from 44.2 to 44.7 KB.

The +0.42 KB is the feature's cost: validation, stamping, three methods, and the persisted user
set. It is not optional for JUHI. After #159 lands (budget 45.0, measured 44.9), the merged budget
needs about 45.4.

## Verified

- Unit tests:
  - Browser vitest: `attributes.test.ts`.
  - React Native vitest: `attributes.test.ts`, 7 tests. The full suite had 218 of 219 passing;
    the one failure was a sampling-test timeout under load, and the test passes alone.
  - iOS `./test.sh`: 4 runs green.
  - `go test ./...` and `go vet`.
  - Plugin `tsc` and jest: 211 of 218 passed in the first run. The 7 failures were load timeouts
    and pass with `--testTimeout=60000`.
- CI: title, node, Go, images and examples are green; swift and android were pending when this
  summary was written.
- Live stack (compose project `f1f2attr`, ports 26100-26112):
  - Collector image reused from a local `ouo/collector` build.
  - rum-api was cross-compiled on the host and layered on a local rum-api image, because
    BuildKit kept dying under load ("frontend grpc server closed").
  - The demo web app ran on :26120 with user `vip-7`. Its session record came back with
    `{plan: pro, storefront: web-store, tenant: acme}`.
  - Filters: `attr.tenant=acme` → 1 session; adding `attr.plan=pro` → 1; `attr.tenant=other` → 0;
    `attr.ten-ant=x` → 400.
  - Loki labels are unchanged (`event_name`, `ouo_platform`, `ouo_project_id`, `service_name`,
    `deployment_environment_name`).
  - Grafana, checked with headless Playwright using Basic auth: the Sessions page shows the
    `tenant = acme` chip and 1 session, and the session page shows the Attributes row.
- RN on the iOS simulator (my own `ouo-f1f2`, iPhone 18 Pro, iOS 27.0):
  - `examples/ouo-mobile` Release build with the stack URLs and
    `EXPO_PUBLIC_OUO_BUNDLE_ID=ota-demo-7` / `_CHANNEL=production` baked in.
  - Chaos → Set user → Flush.
  - rum-api record: `user-170`, `bundle_id ota-demo-7`, `bundle_channel production`,
    `attributes {plan: free, tenant: acme}`.
  - Filters: `bundle=ota-demo-7&attr.tenant=acme` → 1 session; `bundle=nope` → 0.
  - Health bucket: `mobile 2.4.0 ota-demo-7`.
  - Grafana: the Overview has a Bundle column in the Mobile table only, and the session page
    shows the Bundle and Attributes rows. Screenshots `f1f2-grafana-*.png` are in the group's
    shared notes folder.

## Left / next agent

- When #159 (consent) merges:
  - Add `setAttributes`, `removeAttribute` (both SDKs) and `setBundle` (RN) to the consent gate's
    queued calls (`src/consent.ts`).
  - Merge the size budget.
- When #162 (project selector) merges, conflicts are expected in:
  - `sessions.go` (`listQuery`)
  - `stats.go` (bucket key and sort, `project_id`)
  - `fold.go`
  - the plugin's `Sessions.tsx`, `Overview.tsx` (`sessionsLink`) and `VersionTable.tsx` (row key)
- `tests/e2e/scenario.mjs` has no attribute check yet: #162 changes the same file.
