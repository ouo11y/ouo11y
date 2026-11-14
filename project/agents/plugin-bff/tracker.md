# plugin-bff tracker

| Date | Event |
|---|---|
| 2026-11-13 | PR #189 (ADR-0023: BFF with a c0–c5 Clearance ladder in `ouo-go`, `ouo-kit` player, Session explorer, e2e 14/14) and PR #191 (ADR-0024: Clearance from IdP groups through a nested datasource with `oauthPassThru`, Keycloak, e2e 18/18), both reviewed and agreed, not merged |
| 2026-11-14 | Founder direction: clients own their backend, frontend and access model; we ship generic libraries. ADR-0025 proposed. `libs/ouo-go` made generic (no `Clearance`, public reads, `redact` and `oidc` sub-packages), `@ouo11y/kit` made publishable (release-please component `kit`), kb moved to `project/kb/plugin/{backend,idp-tokens}`. #189 and #191 closed in favour of the new PR; the founder merges |

## Open

- Founder: ADR-0025; first `kit-v0.1.0` tag and the npm trusted publisher for `@ouo11y/kit` (docs/releasing.md).
- Demo client zero (own repository): its backend and frontend, starting from #189/#191's BFF, explorer and e2e code.
- Pixel players on `ouo-frames/3` and `ouo-video/1` in `@ouo11y/kit`.
- `oidc`: a waiting call does not honour its own context while another call fetches the keys (review of #191, finding 2; bounded by the 10 s client timeout).
