# ADR-0025 We ship generic libraries; each client owns its plugin backend, frontend and access model

Status: **proposed** (2026-11-14). Supersedes ADR-0023 ("The plugin gets a Go BFF with Clearance, `ouo-go` and `ouo-kit`") and ADR-0024 ("Clearance levels from IdP groups"), which were proposed in PRs [#189](https://github.com/ouo11y/ouo11y/pull/189) and [#191](https://github.com/ouo11y/ouo11y/pull/191) and never merged; they are kept on those branches for the record. Numbers 0022 to 0024 are taken by open or closed pull requests, so this is 0025.

## 1. Context

ADR-0023 and ADR-0024 made one plugin for everyone: a Go BFF inside `ouo11y-rum-app`, a Session explorer, and Clearance, a fixed ladder of levels c0 to c5 decided from Grafana roles or identity-provider groups. `libs/ouo-go` enforced the ladder on every read: each public function took a `Clearance`, and the level table lived in the library.

Founder direction, 2026-11-14:

- Clients build their own plugin backend and frontend. We provide generic libraries they may use or not.
- Clients choose their own access model: their own groups, a ladder, or nothing, with plain Grafana Viewer, Editor and Admin enough.
- Client plugins, including a demo "client zero" that serves as the example, live outside this repository.

A ladder in the library forces one access model on every client, and a BFF in our plugin is a backend a client did not choose. Both go.

## 2. Decision

**We ship generic libraries. The backend, the frontend and authorization belong to each client.**

| Piece | Where | What it is |
|---|---|---|
| `ouo-go` | `libs/ouo-go`, Go module `github.com/ouo11y/ouo11y/libs/ouo-go`, Apache-2.0 | Typed readers that return the data as stored: `Loki.ListSessions`, `Loki.SessionEvents`, `Muninn.ListReplays`, `Muninn.Manifest`, `Muninn.Chunk`, and the raw `Loki.QueryRange` / `QueryVector`. Since amendment 1, also the readers whose definitions depend on our telemetry schema, ported from rum-api: funnels (`Loki.Funnel`, `FunnelDropped`, `FunnelSteps`, [spec](../specs/funnels.md)), session health % (`Loki.Health`, ADR-0004), a session's mobile vitals (`Loki.SessionVitals`, [spec](../specs/mobile-vitals.md)) and its traces (`Tempo.SessionTraces`, a reader type of its own). Identifiers and filter values are validated before they reach LogQL, TraceQL or a store path. No user, role, level or `Clearance` argument anywhere |
| `ouo-go/redact` | sub-package, optional | Identity-key detection (`enduser.*`, `user.*`, `client.address`, matching `.` and `_` spellings) and attribute filters that take the caller's keys or predicate (`Drop`, `Keep`, `Session`, `Sessions`, `Events`, `Manifest`). It decides nothing about who sees what |
| `ouo-go/oidc` | sub-package, optional | Verifies an OpenID Connect ID token (JWKS signature, asymmetric algorithms only, issuer, audience, expiry; one key fetch a minute at most) and returns its claims or groups. It maps them to nothing |
| `@ouo11y/kit` | `libs/ouo-kit`, npm, Apache-2.0 | `ReplayPlayer` (a Muninn manifest plus a chunk fetcher the caller supplies), `RrwebPlayer`, the replay format seam and the manifest types. React and `rrweb-player` only; no Grafana and no backend of ours assumed. Published to npm through release-please (component `kit`) and `release-npm.yml` |

What a client decides, with or without the libraries:

- **Its backend**: a Grafana plugin backend (app, or datasource when it needs the user's IdP tokens, [kb](../../project/kb/plugin/idp-tokens/idp-tokens-in-a-plugin-backend.md)), a service of its own, or none.
- **Its frontend**: Grafana pages, another React app, or Grafana's own Explore.
- **Its access model**: IdP groups (verified with `oidc` or otherwise), a ladder of its own, plain Grafana Viewer, Editor and Admin, or nothing. The libraries neither require nor favour one.

**The MVP plugin and rum-api go** (amendment 1). `plugins/ouo11y-rum-app` is deleted together with `services/rum-api` once ADR-0026 (debug files and erasure, branch `claude/rum-api-leftovers-33b874`, not merged on 2026-11-14) and the `ouo-go` readers of amendment 1 are released. Until then both stay as on `main` and get no new features: not the BFF, the Session explorer or the nested datasource from #189 and #191. Those, with their Keycloak stack (`compose.idp.yaml`), the `--idp` and `--muninn` changes to `ouo-env`, the Helm and Grafana image changes and the `tests/e2e/plugin-bff` scenarios, are reference material for the demo client zero, which will live in its own repository.

**`libs/` is a new top-level folder** (ADR-0010 allows one only through an ADR; this is it, since ADR-0023 was not merged). It holds libraries that clients import, under Apache-2.0, released on their own lines, and nothing else. Rejected: `services/` (they are not services, and services are AGPL-3.0), `sdk/` (SDKs run in the client's app and emit telemetry; these read it), and a folder inside the plugin (it could not be imported without the plugin and would carry its release cycle).

## 3. Consequences

- A client that wants a ladder writes one table and a call to `redact` per answer; a client that wants none passes everything. Neither pays for the other's model.
- Deny by default is now the client's job. The libraries return everything they read, identity included; `redact.Identity` with `redact.Session`, `Sessions`, `Events` and `Manifest` removes identity from everything the readers return, and the README says that chunk attributes may carry identity (MUN-6).
- `oidc` does not bind a token to the calling Grafana user, and a datasource's settings can be replaced by an org Admin who creates their own instance. Both are written in the kb with the attacks the verification was tested against, so a client sees them before choosing groups.
- `@ouo11y/kit` gets its own version line from 0.1.0; the founder pushes `kit-v0.1.0` and publishes once by hand so its npm trusted publisher can be set ([releasing](../releasing.md)). `ouo-go` is released by tag (`libs/ouo-go/vX.Y.Z`). While this repository is private, a client repository fetches it with `GOPRIVATE=github.com/ouo11y/*` and git credentials (a token in GitHub Actions), as its [README](../../libs/ouo-go/README.md#install-from-a-client-repository) says.
- What #189 and #191 found stays: the kb entries under [project/kb/plugin](../../project/kb/plugin/index.md), the review findings fixed in the library code (identity in chunk attributes, the Sentry bridge's `user.id`, `truncated` on long sessions, store errors kept out of answers, one key fetch a minute).
- Funnels, session health %, vitals and session traces are `ouo-go` readers, not something each client rebuilds (founder, 2026-11-14), because their definitions follow our telemetry schema: a client that rebuilt them would drift when the schema changes. The ports keep rum-api's definitions and tests; where the two differ, `libs/ouo-go/funnels.md` says why.

## Amendments

1. 2026-11-14: rum-api's funnels, health %, vitals and session traces become `ouo-go` readers (decision row and consequences above); the MVP plugin is deleted with rum-api once ADR-0026 and these readers are released, instead of staying as on `main`. A funnel page step also matches the web SDK's `browser.navigation` (path of `url.full`) since 0.4.0, and a funnel's users are `enduser.id`, else `user.id`: [spec](../specs/funnels.md). The status stays for the founder to set.
