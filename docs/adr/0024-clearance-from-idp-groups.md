# ADR-0024 Clearance levels come from identity-provider groups

Status: **proposed** (2026-11-13). Built in the same pull request, stacked on [ADR-0023](0023-plugin-bff-and-clearance.md)'s. The founder merges, after the questions in [section 7](#7-founder-questions).

It replaces ADR-0023 section 4.2 (from a Grafana user to a level) and moves the BFF of its section 2 from the app plugin's backend to the backend of a datasource nested in the same plugin. Everything else in ADR-0023 stands.

## 1. Context

Founder, 2026-11-13: identity belongs to the identity provider (IdP), and a user's Clearance level is decided from the user's IdP groups. The stack runs open-source Grafana, where syncing IdP groups to Grafana teams is not available (it is an Enterprise feature).

ADR-0023 resolved a level from the Grafana login, then from the Grafana org role. A local Grafana user may change their own login, so a per-login level could be claimed by renaming.

## 2. How the backend learns the user's groups

Checked in Grafana 13.2.5's source and in a running env with Keycloak 26.8.1; the captures and the exact settings are in [the kb entry](../../project/kb/plugin/clearance-idp/idp-groups-in-a-plugin-backend.md).

| Option | On open-source Grafana 13.2.5 |
|---|---|
| The user's IdP tokens forwarded to an **app** plugin's backend | **Does not exist.** The middleware that adds them runs only for a datasource instance with `jsonData.oauthPassThru`. An app backend receives no `Authorization` and no `X-Id-Token` |
| The user's IdP tokens forwarded to a **datasource** plugin's backend | **Works.** With `oauthPassThru: true` every resource call carries the access token (`Authorization`) and the ID token (`X-Id-Token`), and Grafana refreshes them when they expire |
| Grafana's own signed ID token (`X-Grafana-Id`), which every plugin backend receives | Carries login, email and org role. Its `groups` claim is the user's Grafana teams, which nothing fills from the IdP without Enterprise team sync. With `[auth] id_use_external_groups_for_groups_claim` it carries IdP groups only for auth-proxy and JWT sign-in; for an OAuth sign-in the groups exist on the sign-in request alone and the claim is absent afterwards |
| Grafana's user and team APIs from the backend | The groups are not stored for OAuth users; teams need Enterprise team sync or hand-kept membership, and a service account for the plugin |
| IdP groups mapped to the Grafana org role at sign-in (`role_attribute_path`), then the role mapped to a level | Works with no code, but gives three levels at most and ties what a user may edit in Grafana to what personal data they may see |

**Decision: the BFF is the backend of a datasource nested in the plugin** (`ouo11y-rum-datasource`, in `plugins/ouo11y-rum-app/src/datasource/`), provisioned once with `oauthPassThru: true`. The Session explorer calls `/api/datasources/uid/ouo11y/resources/v1/...`; the five resources and their answers are unchanged. The app plugin has no backend of its own any more: one backend, one place for its settings. The nested datasource runs no dashboard queries.

## 3. From a user to a level

The secure setting `clearance` has a `mode` and two maps. Exactly one mode applies.

| `mode` | The level is |
|---|---|
| `groups` | the **highest** level among the user's groups in `groups` (group name to level 0 to 5). The groups are the `groups` claim (the name is a setting) of the ID token in `X-Id-Token`. Group names match exactly |
| `roles` | the level of the user's Grafana org role in `roles`. For a Grafana with no IdP: local development and the plain compose stack |
| anything else, or no setting | 0 for everyone |

Deny by default, at every step: no token, a token that fails any check, a group that is not in the map, no group at all, all give level 0. In `groups` mode the org role and the login are never read, so a Grafana Admin who did not sign in through the IdP has level 0 in the plugin. There is no default map: a stack that wants `roles` mode says so.

**The per-login override is removed.** It was the one thing a user could claim by renaming themselves, and groups do its job: to give one person a level, put them in a group.

**The role mapping stays, as a mode of its own**, never as a fallback inside `groups` mode. A fallback would let a misconfigured IdP setting silently hand out levels by role.

### The token is verified, not read

`ouo-go`'s `OIDC.Groups` accepts a token only when all of these hold:

- its signature verifies against a key from the IdP's JWKS, with an asymmetric algorithm (RSA, ECDSA, EdDSA; `none` and HMAC are refused);
- `iss` equals the configured issuer;
- `aud` contains the configured audience (the OAuth client id Grafana signs in with);
- it has an `exp`, and it is not expired (30 seconds of leeway for clock difference) and not before its `nbf`.

Keys are cached for an hour; an unknown key id refetches them at most once a minute, so a rotated key is picked up and a forged key id does not become a request per call. If the keys cannot be fetched and none are held, nothing verifies.

`X-Id-Token` is a request header, and a browser can send one. That is why the content of the header is worth nothing without the signature. For a user who signed in through the IdP, Grafana overwrites the header with the stored token.

### When a group change takes effect

At the user's next sign-in, or when Grafana next refreshes the user's tokens, whichever comes first, because each brings a new ID token. The refresh happens when the token expires, so the delay is at most the IdP's ID-token lifetime (60 seconds in the test realm; set by the IdP, commonly 5 to 60 minutes) plus the leeway. Grafana needs `use_refresh_token = true`.

## 4. Where the settings live

On the provisioned datasource (`deploy/compose/grafana/provisioning/datasources/datasources.yaml`):

| Setting | Where | Readable by |
|---|---|---|
| `oauthPassThru: true`, `lokiUrl`, `muninnUrl`, `muninnTenant`, `oidc.issuer`, `oidc.audience`, `oidc.jwksUrl`, `oidc.groupsClaim` | `jsonData` | any signed-in user |
| `clearance`: a JSON object `{"mode", "groups", "roles"}` | `secureJsonData` | nobody; Grafana hands it only to the backend |
| `muninnReadToken` | `secureJsonData` | nobody |

This closes the gap ADR-0023 section 4.4 stated ("its configuration is not secret"): the mapping of groups to levels cannot be read back, by a Viewer or by an Admin. What stays readable says where tokens come from, not who may see what.

## 5. What this does not do

- **It needs an OIDC sign-in.** SAML is Enterprise. Auth-proxy and JWT sign-in have no forwarded ID token; they would use `X-Grafana-Id` with `id_use_external_groups_for_groups_claim`, a third mode that is not built.
- **Groups must be in the ID token.** A provider that puts groups only in the access token or the userinfo answer needs a mapper (Keycloak: a group-membership mapper with "add to ID token"). Providers that send group ids (Entra ID) are mapped by id.
- **A valid token of another user would be honoured.** A signed-in Grafana user with no IdP tokens of their own who presents another user's valid, unexpired ID token gets that user's level. Grafana keeps ID tokens on its server and never sends them to a browser, so this needs a theft from Grafana's database or from the network between Grafana and the IdP. Binding the token to the calling user (matching it against `X-Grafana-Id`) closes it and is not built.
- **A revoked group lives until the token expires**, as above.
- **Grafana's own Explore is still outside Clearance** (ADR-0023 section 4.4), and Clearance is still per Grafana org, not per project.
- **The nested datasource is a second unsigned plugin id.** `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` must list `ouo11y-rum-app,ouo11y-rum-datasource`; with only the first, the app loads and the Session explorer has no backend. The compose stack, the Grafana image and the chart's Grafana list both; the released quickstart file follows the released image and changes with the next plugin release.

## 6. What was built

- `libs/ouo-go`: `oidc.go` (the verifier; dependency `github.com/go-jose/go-jose/v4` for JWS and JWKS), `ClearanceConfig{Mode, Groups, Roles}`, `Resolve(cfg, login, role, groups)`.
- Plugin: `src/datasource/` (manifest and a module with no queries), `pkg/` built as `dist/datasource/gpx_ouo11y-rum-datasource_<os>_<arch>`, the frontend's base path.
- `ouo-env up <env> --idp`: `deploy/compose/compose.idp.yaml`, Keycloak with the realm `deploy/compose/keycloak/realm-ouo.json` (three groups, three users), Grafana signing in through it, Clearance in `groups` mode.
- `tests/e2e/plugin-bff/clearance-idp.mjs`: two IdP users in different groups, a user with no group, a group move, and local Grafana users who rename themselves and forge the header.

## 7. Founder questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | The BFF moves to a nested datasource, because that is the only place open-source Grafana forwards the user's IdP token. Accept? | **Yes.** The alternatives are three levels through the org role, or putting a proxy in front of Grafana to sign users in |
| Q2 | Remove the per-login override entirely? | **Yes.** A group of one does the same and cannot be claimed by renaming |
| Q3 | `roles` mode as an explicit mode for a Grafana with no IdP, never a fallback? | **Yes** |
| Q4 | Bind the ID token to the calling Grafana user (section 5, third point) before a pilot? | **Not before the first pilot**; do it before a customer runs local Grafana users beside IdP users |
| Q5 | Which IdP does the first pilot customer use? | It decides the claim name, whether groups are names or ids, and the token lifetime; the built path is tested on Keycloak only |
