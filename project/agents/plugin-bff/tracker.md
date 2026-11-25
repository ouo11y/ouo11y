# plugin-bff tracker

| Date | Event |
|---|---|
| 2026-11-13 | PR #189 (ADR-0023: BFF with a c0–c5 Clearance ladder in `ouo-go`, `ouo-kit` player, Session explorer, e2e 14/14) and PR #191 (ADR-0024: Clearance from IdP groups through a nested datasource with `oauthPassThru`, Keycloak, e2e 18/18), both reviewed and agreed, not merged |
| 2026-11-14 | Founder direction: clients own their backend, frontend and access model; we ship generic libraries. ADR-0025 proposed. `libs/ouo-go` made generic (no `Clearance`, public reads, `redact` and `oidc` sub-packages), `@ouo11y/kit` made publishable (release-please component `kit`), kb moved to `project/kb/plugin/{backend,idp-tokens}`. #189 and #191 closed in favour of the new PR; the founder merges |

| 2026-11-14 | rum-api's funnels, health %, vitals and traces ported to `ouo-go` (`Loki.Funnel`/`FunnelDropped`/`FunnelSteps`, `Loki.Health`, `Loki.SessionVitals`, `Tempo.SessionTraces`); live comparison with rum-api equal except the web SDK 0.4 wire rum-api's funnels miss; README install section; ADR-0025 amendment 1 ([summary](summaries/2026-11-14-ouo-go-readers.md)). PR open, the founder merges |
| 2026-11-25 | `@ouo11y/kit` plays `ouo-video/1` (`VideoPlayer`, `parseVideoChunk`, `videoTimeline`; `ReplayPlayer` dispatches by format, no new prop) ([summary](summaries/2026-11-25-kit-video-player.md)). PR open |

## Open

- Founder: ADR-0025; first `kit-v0.1.0` tag and the npm trusted publisher for `@ouo11y/kit` (docs/releasing.md).
- Demo client zero (own repository): its backend and frontend, starting from #189/#191's BFF, explorer and e2e code.
- Frames player on `ouo-frames/3` in `@ouo11y/kit` (`ouo-video/1` plays since 2026-11-25; check it on a real recording in a browser).
- `oidc`: a waiting call does not honour its own context while another call fetches the keys (review of #191, finding 2; bounded by the 10 s client timeout).
- After this PR and ADR-0026 merge: tag `libs/ouo-go/v0.2.0`; delete `services/rum-api` and `plugins/ouo11y-rum-app`; let `erase` use `ouogo.Tempo`.
