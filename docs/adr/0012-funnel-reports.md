# ADR-0012 Funnel reports: page and custom-event steps, session-counted, computed by rum-api from Loki

Status: accepted (2026-10-24, step kinds decided by the founder). Amended by [ADR-0019](0019-funnel-step-conditions-and-failed-outcome.md): event-step conditions, a failed outcome per step, a truncated flag.

## Context

The founder wants funnel reports (checklist N46, then quickstart 5): how many sessions go from a landing page through product, cart and checkout to a paid order, where they drop, and the replays of those that dropped. ouo already has everything a funnel needs in Loki: the browser SDK records every page load and route change as a `navigation` log record with `url.path`, and `rum.addEvent` records custom events by `event.name`, all with `session.id` and `user.id` (ADR-0002). What was missing is the definition of a step, the counting rules and a place to compute it.

Options considered:

1. **Grafana panels over LogQL only.** A LogQL metric query can count sessions with a step, but not sessions with step 2 *after* step 1 of the same session: ordered, per-session logic does not exist in LogQL.
2. **A new pre-aggregated store** (a funnel table written at ingest). Fast, but funnels are defined after the fact, so it would need every path and event per session stored again, a new component to operate, and it breaks "telemetry stays in LGTM" (ADR-0001).
3. **rum-api reads Loki at query time** and computes funnels in memory, as it already does for sessions and health (ADR-0004).

## Decision

1. **Option 3.** rum-api gets `POST /v1/funnels/query`, `GET /v1/funnels/dropped` and `GET /v1/funnels/steps`. The pure logic lives in `services/rum-api/internal/funnel`; the HTTP layer runs one Loki query per step kind (navigation events narrowed to the step paths, and the step event names), joins them per session in memory and caches the result for 60 s.
2. **A step is a page path (exact or prefix) or an event name.** No click targets, query strings or attribute conditions in v1 (founder, 2026-10-24): page paths and event names are already low-cardinality, stable across releases and present on every platform that emits `navigation` and custom events; click targets are not.
3. **The session is the counting unit,** with distinct users shown next to it. A session is the unit of replay and health; per-user funnels across sessions would need a user-level window and identity stitching that the MVP does not have.
4. **Strict order inside one session**, every step-1 occurrence tried as a start, deepest path wins; optional `within` window from step 1; only events inside the requested range count. The exact rules are in [docs/specs/funnels.md](../specs/funnels.md).
5. **The plugin gets a Funnels page.** Steps live in the URL (`?step=page:/&step=event:add_to_cart`) so a funnel is shared by copying the link; no saved-funnel storage in v1.

## Consequences

- No new component, no ingest change, works for every app already sending `navigation` and custom events; mobile screens (`navigation` with the screen name in `url.path`) work the same way.
- Query cost grows with the number of navigation and step events in the range, not with the number of funnels. The read is bounded (100,000 events per step kind, 31 days, 10 steps); a very busy app has to narrow the range or the filters. If that becomes the norm, a pre-aggregation can be added behind the same API.
- A session that started before the range is not counted even when it converts inside it. This is deliberate (a range's funnel is about that range) and documented.
- Saved funnels, click-target steps, attribute filters on steps and per-user funnels are follow-ups that need their own ADR.
