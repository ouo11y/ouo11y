# How a Grafana plugin backend learns the user's IdP groups (open-source Grafana)

> On open-source Grafana, how can the Go backend of a plugin read the signed-in user's identity-provider groups, without Enterprise team sync?

**Answer: only a datasource plugin's backend gets the user's IdP tokens, and only when the datasource instance sets `jsonData.oauthPassThru: true`. An app plugin's backend never does.** So the ouo11y BFF is the backend of a datasource nested in the app plugin ([ADR-0024](../../../../docs/adr/0024-clearance-from-idp-groups.md)).

Verified 2026-11-13 on `grafana/grafana:13.2.5` (source at tag `v13.2.5` and a running env), Keycloak 26.8.1, `grafana-plugin-sdk-go` v0.299.0, env `clearidp` (`ouo-env up clearidp --muninn --idp`).

## The options, and what each gave

| Option | Result | Evidence |
|---|---|---|
| IdP tokens forwarded to an **app** backend | No. No setting enables it | `pkg/services/pluginsintegration/clientmiddleware/oauthtoken_middleware.go`: `applyToken` returns at once when `pCtx.DataSourceInstanceSettings == nil`. Capture A |
| IdP tokens forwarded to a **datasource** backend | Yes, on every `CallResource`, `QueryData` and `CheckHealth`, when `jsonData.oauthPassThru` is true | Same file. Capture B |
| Grafana's ID token, `X-Grafana-Id` | Every plugin backend gets it, no setting needed. Claims: `sub` (`user:<id>`), `username`, `email`, `role`, `authenticatedBy`, `aud` (`org:<id>`), 10 minutes of life, ES256, keys at `/api/signing-keys/keys`. **No IdP groups** | `forward_id_middleware.go`, `pkg/services/auth/idimpl/service.go`. Captures A and B |
| `[auth] id_use_external_groups_for_groups_claim = true` | Puts IdP groups in `X-Grafana-Id` only where the sign-in method supplies them on every request: auth proxy and JWT. For generic OAuth the groups exist on the sign-in request only; a session request has none, and the claim is absent | `idimpl/service.go` `resolveGroupsClaim`; `authn/clients/oauth.go` sets `ExternalGroups` at sign-in, `clients/proxy.go` rehydrates them, the session client does not. Tried with `GF_AUTH_GENERIC_OAUTH_GROUPS_ATTRIBUTE_PATH=groups`: the token had no `groups` |
| Grafana teams in `X-Grafana-Id` (`groups` = team uids) | Only as good as team membership, which the IdP fills only with Enterprise team sync | `idimpl/service.go` |
| Session cookie forwarded so the backend could call Grafana as the user | No: cookies are cleared for anything but a datasource with `keepCookies` | `cookies_middleware.go` |
| Org role from groups at sign-in (`role_attribute_path`) | Works, no code; three levels at most, and it couples Grafana editing rights to Clearance | Grafana docs, generic OAuth |

## The settings that make it work

Grafana (`deploy/compose/compose.idp.yaml`):

```ini
[auth.generic_oauth]
enabled = true
client_id = grafana
client_secret = <secret>
scopes = openid email profile
auth_url = <browser-facing IdP>/realms/ouo/protocol/openid-connect/auth
token_url = http://keycloak:8080/realms/ouo/protocol/openid-connect/token
api_url = http://keycloak:8080/realms/ouo/protocol/openid-connect/userinfo
use_refresh_token = true    ; a refreshed ID token carries the user's current groups
```

The datasource instance (`deploy/compose/grafana/provisioning/datasources/datasources.yaml`):

```yaml
- name: ouo11y
  uid: ouo11y
  type: ouo11y-rum-datasource
  access: proxy
  jsonData:
    oauthPassThru: true          # the one switch
    oidc: { issuer: <browser-facing IdP>/realms/ouo, audience: grafana, jwksUrl: http://keycloak:8080/realms/ouo/protocol/openid-connect/certs }
  secureJsonData:
    clearance: '{"mode": "groups", "groups": {"rum-support": 1, "rum-privacy": 4}}'
```

Keycloak: the client needs a **group-membership mapper** with `id.token.claim=true` (`claim.name=groups`, `full.path=false` for plain names). Without it the ID token has no groups.

Grafana must allow both unsigned ids: `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app,ouo11y-rum-datasource`. With only the app's id Grafana logs `plugin 'ouo11y-rum-datasource' has no signature` and skips it; the parent's permission does not cover the nested plugin.

## Captures

Headers the backend received for user `omar` (Keycloak group `rum-privacy`, Grafana Viewer), signed in through Keycloak. Tokens are shown as their decoded payload; signatures, `jti`, `sid` and `sub` values are removed.

**A. App plugin backend** (`GET /api/plugins/ouo11y-rum-app/resources/v1/...`): no `Authorization`, no `X-Id-Token`.

```text
Accept, Accept-Encoding, Accept-Language, Sec-Fetch-Mode, X-Forwarded-For, X-Forwarded-Server, X-Real-Ip, X-Grafana-Referer
X-Grafana-Id  {"aud":"org:1","authenticatedBy":"oauth_generic_oauth","email":"omar@ouo.test","exp":…,"iat":…,
               "identifier":"…","iss":"http://grafana.clearidp.ouo.localhost/","name":"Omar Privacy",
               "namespace":"default","role":"Viewer","sub":"user:2","type":"user","username":"omar@ouo.test"}
```

**B. Datasource plugin backend with `oauthPassThru`** (`GET /api/datasources/uid/ouo11y/resources/v1/...`): the same, plus

```text
Authorization Bearer {"exp":…,"iat":…,"iss":"http://keycloak.clearidp.ouo.localhost/realms/ouo","typ":"Bearer","azp":"grafana",
               "scope":"openid profile email","groups":["rum-privacy"],"preferred_username":"omar","email":"omar@ouo.test", …}
X-Id-Token    {"exp":…,"iat":…,"iss":"http://keycloak.clearidp.ouo.localhost/realms/ouo","aud":"grafana","typ":"ID","azp":"grafana",
               "groups":["rum-privacy"],"preferred_username":"omar","email":"omar@ouo.test", …}
```

The SDK names the headers `backend.OAuthIdentityTokenHeaderName` (`Authorization`) and `backend.OAuthIdentityIDTokenHeaderName` (`X-Id-Token`); with `httpadapter` they are ordinary request headers.

## What else holds

- **Which token to verify.** The ID token: its `aud` is the client id, so the audience check means "issued for this Grafana". Keycloak's access token has no `aud` for the client by default.
- **Present on every call?** Yes for a user who signed in through the IdP. A user who signed in with a Grafana password, a service account or an API key has no tokens: the headers are absent.
- **After a refresh.** Grafana refreshes the stored tokens when they expire (needs `use_refresh_token`, and the IdP must return a new ID token on refresh; Keycloak does) and forwards the new ones. Measured: tokens living 60 s, a user moved to another group in Keycloak, the open Grafana session got the new group after 50 s without signing in again. A new sign-in gets it at once.
- **The header can be sent by a browser.** Grafana passes request headers on to the backend, so a user with no IdP tokens can send `X-Id-Token` themselves; for a user with tokens Grafana overwrites it. Verify the signature against the IdP's keys or the header is worth nothing.
- **The issuer is the browser-facing URL**, which a container often cannot reach (`*.localhost`). So the keys URL is its own setting (`oidc.jwksUrl`, the in-network address), not derived from the issuer.
- **Datasource `jsonData` is sent to every signed-in user's browser**; `secureJsonData` only to the backend (`DecryptedSecureJSONData`). A structured secret goes in as one JSON string.
- **Signing in over HTTP in a test.** `GET /login/generic_oauth` with a cookie jar and redirects followed lands on Keycloak's form; `POST` `username` and `password` to the form's `action`; the redirects end in a Grafana session cookie. No browser needed (`tests/e2e/plugin-bff/clearance-idp.mjs`).
- **Keycloak realm import** (`start-dev --import-realm`) replaces `${ENV_VAR}` in the realm file, which is how the redirect URI follows the env's Grafana URL.
- **Keycloak `start-dev` keeps its state in the container.** Recreating the container imports the realm again with new user ids, and Grafana, which links an OAuth user to the token's `sub`, then fails the sign-in of a user it already has (`user.sync: Failed to create user: user not found`). Give the users an `id` in the realm file.
