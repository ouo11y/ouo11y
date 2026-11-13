# ADR-0025 Funnels and the Home page move into the BFF, on the spec wire

Status: **proposed** (2026-11-13). Not to be merged by a session; the founder merges after confirming [section 6](#6-founder-questions-and-recommendations). Built on the recommendations, stacked on [ADR-0023](0023-plugin-bff-and-clearance.md)'s second slice.

Number 0024 is taken by an open pull request (Clearance from IdP groups), so this is 0025.

## 1. Context

- The MVP funnel engine lives in rum-api (`services/rum-api/internal/funnel`, [ADR-0012](../adr-archive/0012-funnel-reports.md), [spec](../specs/funnels.md)) and reads the MVP wire (`navigation` with `url.path`). The web SDK 0.4 sends `browser.navigation` with `url.full`; the mobile SDK 0.4 sends `navigation` with `url.path` (the screen). No released SDK feeds the MVP engine any more.
- PR #168 adds step conditions and a "failed" outcome to the MVP engine; it is unmerged.
- The MVP Overview page reads rum-api's session summaries, which the spec wire does not produce.
- The founder's demo needs critical business flows as funnels over web and mobile sessions, a landing page with session health and vitals, and data from more than one store. Clearance applies to all of it (ADR-0023 section 4).

## 2. Decision

**The funnel engine moves into `ouo-go` as typed functions, and rum-api's copy is left to retire with rum-api.** `WalkFunnel`, `FunnelPaths` and `FunnelReportOf` are pure; `Client.RunFunnel` and `Client.FunnelDropped` read Loki and apply Clearance. The rules are the MVP spec's (strict order, every step-1 occurrence tried as a start, deepest path wins, optional window, median and p75 between steps), plus from PR #168, which were cheap to carry:

- **conditions** on event steps (`=`, `!=`, `=~` anchored RE2; up to five; a missing attribute reads as `""`), matched in Go on the Loki labels, not translated to LogQL;
- **the failure event** (default `exception`, configurable with conditions, or off) that splits a drop-off into **failed** (a failure event at or after the last step reached, inside the window) and **abandoned**.

What changed for the spec wire:

- A **page step** matches `browser.navigation` by the path of `url.full` and `navigation` by `url.path`. So one funnel counts web pages and mobile screens; the demo flow uses the same paths on both.
- **Platform** of a record is `ouo.platform` when the producer sets it (mobile SDK, Sentry bridge), else `web` for the browser SDK's records (it sets none, see Q4), else the OS name (`PlatformOf`). Every step reports its sessions by platform.
- **Unit and key:** a session is `(project, session.id)`, not `session.id` alone.
- **Reads:** one Loki query for navigations and one for the named events plus the failure event, each bounded by `Client.FunnelLimit` (default 5000 records, Loki's default `max_entries_limit_per_query`); a report that hit it says `truncated`. The MVP engine paged up to 100,000; paging is a later step if a pilot needs it.

**Definitions are provisioned, not edited in the UI.** They sit in the plugin's `jsonData.funnels` (the provisioning file in compose, `grafana.plugin.funnels` in Helm), validated when the plugin instance starts; invalid ones are skipped and named to Admins on the page. Rejected for now: definitions created in the UI (a store, an editor, permissions on who may create one: more than a demo needs) and ad-hoc queries from the browser (see Clearance below). Q1 asks whether the founder wants UI-created funnels next.

**Clearance on funnels:**

| What | Level |
|---|---|
| The list of definitions, and a report's counts, conversion, drop-off, failed share, step times, platform split | c1 in at least one project; sessions of projects the caller sees at 0 are not counted |
| The sessions that dropped at a step (ids, platform, time, outcome, the failure event's name) | c1 in the session's project |
| The user of a dropped session | c4 in its project |
| A session's timeline, attributes, replay | the session rules of ADR-0023, unchanged (the drop-off list links to the session page) |

Conditions name attributes (c2), but only Admins write definitions, so a c1 user sees counts filtered by a condition someone with the right to define it chose. An ad-hoc condition from a c1 user would turn counts into an oracle for attribute values; that is why there are no ad-hoc queries yet. If they come, they need c2.

**Home: one landing page on the spec wire, from two stores.** `Client.GetOverview` answers:

| Section | Store | How |
|---|---|---|
| Session health (share of sessions with no exception or `app.crash`), crash-free, by project and platform | Loki | sessions that **started** in the range (`session.start`), errors from `exception` and `app.crash`; crash = `ouo.exception.fatal=true` or `app.crash` |
| Sessions over time, by platform | Loki | `session.start` per bucket (48 by default) |
| Top errors (by `ouo.exception.fingerprint`, else type and message) | Loki | count, sessions, platforms, last seen, the latest session (a link); type and message need c2 in the project, below that the group shows its fingerprint |
| Web vitals (p75 of LCP, INP, CLS, FCP, TTFB) | Loki | `browser.web_vital` |
| Mobile vitals (p75 of cold and warm start, TTID; slow and frozen frames as a share of frames drawn) | Loki | `ouo.app.start`, `ouo.screen.display`, `app.jank` ([mobile vitals](../specs/mobile-vitals.md)) |
| Backend services: requests per second, error share, p95 of server spans | **Mimir** | Tempo's metrics generator (span-metrics processor, already on in the stack) remote-writes `traces_spanmetrics_*` to Mimir; three PromQL instant queries over the range |

Two Loki reads (session starts and errors; vitals) bounded by the same limit, aggregated in Go, so the code is testable without a Loki and the rules are in one place. Rejected for now: LogQL metric queries (`count_over_time` by `session_id`), which hit Loki's `max_query_series` (500) with more sessions than that. Every Home number is an aggregate and needs c1; the backend section needs c1 in the org (span metrics carry no project).

Tempo also serves a session's traces on the session page (ADR-0023), so the demo reads Loki, Tempo, Mimir and Muninn.

**Frontend: reusable pieces in `ouo-kit`, Grafana wiring in the plugin.** The kit gains `createBffClient` (typed methods for every endpoint, `BffError` with `forbidden` on 403), `useBff` (latest call wins, `forbidden` flag), `SessionTable`, `Timeline`, `FunnelChart`, format helpers, and a theme of CSS custom properties (`--ouo-border`, `--ouo-accent`, ...) that a host sets once (`themeStyle`); the plugin maps Grafana's theme onto it (`KitTheme`). The plugin keeps the pages, the range and project bar, Grafana's `PluginPage`, `Select` and `Alert`. New pages: **Home** (`/a/ouo11y-rum-app/home`, the landing page) and **Business flows** (`/a/ouo11y-rum-app/flows`); the MVP pages stay in the nav, suffixed "(MVP)", until rum-api retires.

## 3. BFF API additions

All `GET`, under `/api/plugins/ouo11y-rum-app/resources/v1`, same errors and `no-store` as ADR-0023 section 3. `scope` is `from`, `to` (ms), `project`, `platform`.

| Path | Answer | Needs |
|---|---|---|
| `/overview?scope` | `Overview` (section 2's table) with `redacted` | c1 |
| `/funnels` | `{funnels: [Funnel], invalid?: [message]}` (`invalid` to Admins) | c1 |
| `/funnels/{id}?scope` | `{funnel, from, to, steps: [{step, sessions, by_platform, conversion_from_first, conversion_from_previous, dropped_off, failed, failure_rate, median_ms, p75_ms}], truncated}` | c1 |
| `/funnels/{id}/steps/{n}/sessions?scope&outcome&limit` | `{step, outcome, sessions: [{project, id, platform, last_step_at, outcome, failed_with, user?}], total, truncated, redacted}`; `n` is 2 to the step count; `limit` default 50, at most 500 | c1 (user: c4) |

A funnel definition (`jsonData.funnels[]`): `id` (`^[a-z0-9][a-z0-9_-]{0,63}$`), `name`, `description`, `steps` (2 to 10 of `{kind: page|event, value, prefix?, where?: [{key, op?, value}], label?}`), `within_seconds` (0 to 7 days), `failure` (an event step) or `no_failure: true`, `project` (restricts it to one project).

## 4. What is built (this pull request)

- `libs/ouo-go`: `funnel.go`, `overview.go` (with a `Mimir` client), tests: the walk rules as a table, the report, validation, `RunFunnel` and `FunnelDropped` against a fake Loki with a project at level 0, `GetOverview` against fake Loki and Mimir at c1, c3 and c5, `PlatformOf`.
- Plugin backend: the four endpoints, definitions from settings, `mimirUrl` (default `http://mimir:9009/prometheus`); endpoint test at c1 and c5.
- `ouo-kit`: client, hook, table, timeline, funnel chart, theme; tests for the client and the chart.
- Plugin: Home and Business flows pages; Session explorer uses the kit's table and timeline; Jest tests for both new pages at c1.
- Compose provisioning: the `shop-checkout` funnel (product page, add to cart, checkout, pay by card, order placed). Helm: `grafana.plugin.funnels`, `mimirUrl` from the chart's Mimir.
- `tests/e2e/plugin-bff`: steps 6 (flows) and 7 (home), 32 checks in all.

## 5. Not in this decision

UI-created funnels, ad-hoc funnel queries, paging past the read limit, cohort or retention charts, dashboards, alerts on a funnel, and removing rum-api's engine (step 6 of the plan, on the founder's word).

## 6. Founder questions and recommendations

1. **Where funnel definitions live.** Recommendation: provisioned in plugin settings now (built); a UI editor storing them in the plugin's settings through Grafana's API, Admin only, once a pilot asks. Alternative: a file in the repo of the client, mounted into Grafana.
2. **Funnel counts at c1.** Recommendation: yes (built), as the brief says; the drop-off list shows session ids at c1 because a session's timeline is c1 already.
3. **Backend metrics are org-wide.** Span metrics carry no `ouo.project.id`, so the Home backend section is shown at c1 in the org and not per project. Recommendation: accept for the pilot; adding `ouo.project.id` as a span-metrics dimension in Tempo is a one-line config when a client has several projects sharing a stack.
4. **The browser SDK sets no `ouo.platform`.** The BFF derives `web` from the browser SDK's own attributes, which works, but the mobile SDK and the bridge set it and the Loki stream label exists for it. Recommendation: the web SDK sets `ouo.platform=web` as a resource attribute in its next minor (a one-line change in `sdk/browser`, not done here because this work does not own `sdk/`).
