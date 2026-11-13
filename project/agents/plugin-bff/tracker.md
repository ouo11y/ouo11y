# plugin-bff tracker

| Date | Event |
|---|---|
| 2026-11-13 | ADR-0023 proposed; `ouo-go`, the plugin backend, `ouo-kit`'s player and the Session explorer built on its recommendations. Go, Vitest, Jest, lint, typecheck, build pass; end to end 14/14 in env `pluginbff`. PR #189 open; the founder merges |
| 2026-11-13 | Review (fresh-context subagent): changes needed, 17 findings; 16 fixed, 1 answered; e2e 14/14 again |
| 2026-11-13 | ADR-0024 proposed: Clearance from IdP groups. Established that only a datasource with `oauthPassThru` receives the user's IdP token on open-source Grafana; the BFF moved to a nested datasource; verified ID token, groups to levels; `ouo-env --idp` (Keycloak). Go, Jest, lint, typecheck, build pass; end to end 18/18 (groups) and 14/14 (roles). PR stacked on #189; the founder merges |

## Open

- Founder: ADR-0023 Q1 to Q10; ADR-0024 Q1 to Q5.
- ADR-0024 section 5: token bound to the calling user, a mode for auth-proxy or JWT sign-in, another IdP than Keycloak.
- Pixel players on `ouo-frames/3` and `ouo-video/1`; teams and per-project Clearance; Q10 (unmasked recordings at c5); Tempo and Mimir on the session page; Helm values.
