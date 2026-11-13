# 2026-11-13 Clearance levels from identity-provider groups

Branch `claude/clearance-idp-groups-f56458`, stacked on `claude/plugin-bff-player-3a00ee` (PR #189, open) at `702ce0a6`. One pull request; the founder merges.

## The mechanism

- On open-source Grafana 13.2.5 the signed-in user's identity-provider (IdP) tokens reach a plugin backend only through a **datasource instance with `jsonData.oauthPassThru: true`**: `Authorization` (access token) and `X-Id-Token` (ID token) on every resource call. An app plugin's backend never gets them, and Grafana's own `X-Grafana-Id` carries no IdP groups for an OAuth sign-in.
- So the BFF is now the backend of `ouo11y-rum-datasource`, a datasource nested in the app plugin. It verifies the ID token (signature against the IdP's JWKS, issuer, audience, expiry) and maps the `groups` claim to a level: the highest among the user's groups, 0 when anything is missing or fails.
- A group change takes effect at the next sign-in, or at Grafana's next token refresh (measured: 50 s with 60 s tokens), whichever is first.

Evidence, settings and captured headers: [kb: idp-groups-in-a-plugin-backend](../../../kb/plugin/clearance-idp/idp-groups-in-a-plugin-backend.md). Decision: [ADR-0024](../../../../docs/adr/0024-clearance-from-idp-groups.md) (proposed), which amends ADR-0023.

## What was done

- **Step 1, before product code**: read `clientmiddleware/` and `auth/idimpl/` of Grafana `v13.2.5`; brought up env `clearidp` with Keycloak and dumped the headers an app backend receives (no IdP token; `X-Grafana-Id` without groups, also with `id_use_external_groups_for_groups_claim=true`). The datasource route was then built and its headers captured (both tokens, `groups` in each). The temporary dump endpoint is not in the diff.
- **`libs/ouo-go`**: `oidc.go` (`OIDC.Groups`: asymmetric algorithms only, key cache of an hour, at most one refetch a minute for an unknown key id, 30 s leeway); `ClearanceConfig{Mode, Groups, Roles}` and `Resolve(cfg, login, role, groups)` with the modes `groups` and `roles`, anything else level 0. The per-login override and the default role map are removed.
- **Plugin**: `src/datasource/` (manifest; a module with no queries); `pkg/main.go` serves a datasource; `pkg/bff` reads `jsonData` (`lokiUrl`, `muninnUrl`, `muninnTenant`, `oidc`) and the secure fields `clearance` (JSON) and `muninnReadToken`; the binaries are `dist/datasource/gpx_ouo11y-rum-datasource_linux_{amd64,arm64}`; the app's `plugin.json` has no backend and lists the datasource; the frontend calls `/api/datasources/uid/ouo11y/resources`. `/me` answers `mode` too.
- **The mapping is no longer readable**: it is a secure field of the datasource (ADR-0023 section 4.4 had it in the app's `jsonData`, readable by Viewers).
- **Stack**: the datasource is provisioned in `deploy/compose/grafana/provisioning/datasources/datasources.yaml`; `OUO_CLEARANCE_MODE` is `roles` in the plain stack; the unsigned list names both plugin ids (compose, the Grafana image, the chart's Grafana).
- **`ouo-env up <env> --idp`**: `deploy/compose/compose.idp.yaml` and `deploy/compose/keycloak/realm-ouo.json` (groups `rum-support`, `rum-engineers`, `rum-privacy`; users `lena`, `omar`, `nora`; 60 s tokens), Keycloak routed at `keycloak.<env>.ouo.localhost`, `OUO_KEYCLOAK_URL` in `ouo-env env`. The earlier Keycloak spike (branch `claude/hosted-stack-design`, not on `main`) gave the image version, the split front and back channel settings and the group mapper.
- **Tests**: `tests/e2e/plugin-bff/clearance-idp.mjs` (new), `record.mjs` (the record step, shared with `run.mjs`), `run.mjs` on the new path.

Dependency added: `github.com/go-jose/go-jose/v4` v4.1.9 in `libs/ouo-go` (and so in the plugin): JWS verification and JWKS parsing, which should not be written by hand. `ouo-go` was standard library only before.

## Verified, and how

| Check | Command | Result |
|---|---|---|
| `ouo-go` | `cd libs/ouo-go && go vet ./... && go test ./...` | pass |
| Plugin backend | `cd plugins/ouo11y-rum-app && go vet ./... && go test ./...` | pass |
| Plugin frontend | `npm run -w plugins/ouo11y-rum-app lint`, `typecheck`, `test`, `build` | 0 errors (the MVP pages' 7 old warnings), clean, 30 suites / 210 tests, built |
| `ouo-kit` | `npm run typecheck -w libs/ouo-kit`, `npm test -w libs/ouo-kit` | clean, 5/5 |
| `ouo-env` | `node --test deploy/envs/lib.test.mjs` | 17/17 (one new: the `--idp` overlay) |
| Quickstart file | `deploy/scripts/gen-quickstart.sh --check` | up to date |
| Groups mode, end to end | `clearance-idp.mjs` in env `clearidp` (`ouo-env up clearidp --muninn --idp`) | 18/18, below |
| Roles mode, end to end | `run.mjs` in env `clearroles` (`ouo-env up clearroles --muninn`, removed after) | 14/14 |

Unit tests cover: highest group wins (any order), unknown group, unknown beside known, exact group names, no token, not a JWT, expired, no expiry, not valid yet, wrong issuer, wrong and missing audience, signed by another key (same and other key id), payload changed after signing, signature removed, `alg: none`, HS256 keyed with the public key, incomplete OIDC settings, key rotation and withdrawal, keys unreachable, groups sent in headers of their own, a login that names a group, groups mode never reading the role and roles mode never reading the token.

`clearance-idp.mjs`, every check from the backend's HTTP answers; all IdP users are Grafana Viewers:

```text
recorded session 2d99274b6a37bb0e28b633533bb8dbec (marker 96bdaec0, SDK @ouo11y/browser 0.4.0 from npm)
PASS  omar (rum-privacy): level c4 from groups, as a Grafana Viewer  ({"login":"omar@ouo.test","role":"Viewer","mode":"groups","level":4,"can":{"timeline":true,"attributes":true,"replay":true,"identity":true}})
PASS  omar: the list answer carries the session's user  (user e2e-user-96bdaec0)
PASS  omar: the session answer carries attributes, the user and the replay list  (13 events, replays 1, redacted [])
PASS  omar: manifest and chunk answer 200  (manifest 200, chunk 200 (94 bytes))
PASS  lena (rum-support): level c1 from groups  ({"login":"lena@ouo.test","role":"Viewer","mode":"groups","level":1,"can":{"timeline":true,"attributes":false,"replay":false,"identity":false}})
PASS  lena: the list answer has the session without its user  (redacted [attributes,replay,identity])
PASS  lena: the session answer has the timeline only: no attributes, no body, no user, replays null  (13 events, redacted [attributes,replay,identity])
PASS  lena: manifest and chunk answer 403  (manifest 403, chunk 403)
PASS  lena: the user id appears in no answer
PASS  lena: a forged X-Id-Token on her session changes nothing  (level 1)
PASS  nora (no group): level 0, list and session answer 403  (level 0, list 403, session 403)
PASS  moved to rum-privacy: lena's open session becomes c4 at the token refresh, without a new sign-in  (level 1 right after the move, c4 after 50s (tokens live 60s in this realm))
PASS  moved to rum-privacy: a new sign-in is c4  (level 4)
PASS  moved back to rum-support: a new sign-in is c1 at once  (level 1)
PASS  local Viewer (not from the identity provider): level 0  ({"login":"e2e-local-1794578823212","role":"Viewer","mode":"groups","level":0, ...})
PASS  local Viewer renames its login to an IdP user's name and to a group's name: still level 0  (omar: rename 200, login omar, level 0; rum-privacy: rename 200, login rum-privacy, level 0)
PASS  local Viewer sends a forged X-Id-Token naming rum-privacy: still level 0  (unsigned: level 0, list 403; signed by its own key: level 0, list 403)
PASS  local Admin: level 0 in groups mode (the org role is not read)  ({"login":"admin","role":"Admin","mode":"groups","level":0, ...})

18/18 passed
```

## What is left, and what the next agent must know

- **Founder**: ADR-0024 Q1 to Q5. Q1 is the one that matters: the BFF moved from the app's backend to a nested datasource's, because nothing else on open-source Grafana carries the user's IdP token.
- **Not built** (ADR-0024 section 5): binding the ID token to the calling Grafana user; a mode for auth-proxy or JWT sign-in; SAML (Enterprise); Helm values for the datasource and its settings (the chart only allows the second unsigned id).
- **Tested on Keycloak only.** Another IdP may name the claim differently, send group ids, or put groups only in the access token.
- **A stack that sets only `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app` loses the Session explorer's backend** once this plugin version is installed (the MVP pages keep working). The quickstart file and the example stacks pin released images and change with the next plugin release; their unsigned list needs the second id then.
- In an `--idp` env the local admin (admin / testing567) has level 0 in the Session explorer: sign in with Keycloak as `omar` (c4) or `lena` (c1).
- `tests/e2e/plugin-bff/run.mjs` needs an env **without** `--idp` (it expects the local admin at c5).
