# ADR-0023 The plugin gets a Go BFF with Clearance, `ouo-go` and `ouo-kit`

Status: **proposed** (2026-11-13). Not to be merged by a session; the founder merges after confirming the choices in [section 7](#7-founder-questions-and-recommendations). The first slice described in [section 6](#6-the-first-slice) is built on the recommendations in the same pull request.

Numbers 0021 and 0022 are taken by open pull requests, so this is 0023.

## 1. Context

Decided before this ADR and not reopened:

- The plugin is a Go BFF plus a frontend. The BFF is the only thing the frontend talks to. It queries Loki, Tempo, Mimir and Muninn, later the Victoria stack, vendor APIs and read-only databases (founder, 2026-11-09 to 11-12; [ADR-0019](0019-collector-to-muninn.md) section 1).
- `ouo-go` holds plain typed Go functions for querying and for applying Clearance. A GraphQL module may sit on top later.
- `ouo-kit` is the frontend library: the replay player for structure and pixel recordings, and building blocks. Clients may use the BFF and both libraries, or build their own UI on top.
- Clearance, role-based redaction in levels, is the most important feature, and it is enforced in the BFF, never in the browser. Muninn returns what is stored (RDR-5).
- The wire is the SDK spec's: telemetry in scope `ouo.rum` in Loki, replay chunks in Muninn with a reference record per chunk in Loki ([Muninn spec](../specs/muninn.md) sections 5 and 7).

What exists: `plugins/ouo11y-rum-app` is MVP code, a frontend only. It reads MVP event names through rum-api via Grafana's route proxy and cannot read the spec wire or Muninn. It has a working rrweb player (`ReplayPlayer.tsx`, a React wrapper over `rrweb-player`) and frames and video players for the MVP mobile formats.

## 2. Where the code lives

| Piece | Where | Licence (proposed, Q6) |
|---|---|---|
| `ouo-go` | `libs/ouo-go`, Go module `github.com/ouo11y/ouo11y/libs/ouo-go`, one package `ouogo` | Apache-2.0 |
| `ouo-kit` | `libs/ouo-kit`, npm workspace package `@ouo11y/kit`, private until it has a second user | Apache-2.0 |
| BFF | The plugin's own Go backend, `plugins/ouo11y-rum-app/pkg`, built with `grafana-plugin-sdk-go`, resource handlers only | Apache-2.0 (as the plugin today) |
| Frontend | The existing plugin, new pages beside the MVP pages | Apache-2.0 |

**The BFF is the plugin backend, not a separate service.** Grafana starts it, passes the signed-in user with every resource call, and proxies `/api/plugins/ouo11y-rum-app/resources/*` to it, so there is nothing new to deploy, expose or authenticate. Rejected: a standalone BFF service behind Grafana's route proxy. It would need its own deployment and would have to trust a user header that the route proxy forwards, which is weaker than the plugin context Grafana hands a backend plugin.

**`ouo-go` is a library the backend imports, in `libs/`.** The functions that apply Clearance must be usable by someone who builds their own BFF, so they cannot live inside the plugin; and a library that others embed takes the embeddable licence, unlike the servers. `libs/` is a new top-level folder, which ADR-0010 allows only through an ADR: this one. It holds the two libraries and nothing else. Rejected: `services/ouo-go` (it is not a service, and services are AGPL-3.0) and `plugins/ouo11y-rum-app/pkg/ouogo` (cannot be imported without the plugin, and would carry the plugin's release cycle).

**`ouo-kit` is a workspace package imported from source.** The plugin's webpack and Jest already transpile anything outside `node_modules`, and the workspace symlink resolves to `libs/ouo-kit/src`, so there is no build step, no publish and no version to bump while the kit has one user. It depends on React and `rrweb-player` only, never on `@grafana/*`, so a client can use it outside Grafana. Rejected: a published package now (nothing to publish for until a second user exists) and a folder inside the plugin (it would grow Grafana imports).

**The existing plugin is extended in place, and its MVP pages are set aside, not ported.** New pages (`/a/ouo11y-rum-app/explore` and `/a/ouo11y-rum-app/explore/:project/:sessionId`) read only the BFF. The MVP pages, their rum-api route and their components stay untouched until rum-api retires, when they are deleted in one change. This is the smaller tree: one plugin id, one provisioning file, one image, one release line, and no copy of the build tooling. Rejected: a second plugin (duplicate scaffold, a second id to sign and provision) and porting the MVP pages (they read event names the spec wire does not have, so porting is rewriting).

**The rrweb player moves to `ouo-kit` as a copy; the MVP copy dies with the MVP pages.** The kit's version drops the `@grafana/ui` styling and takes plain props. The frames and video players are bound to the MVP wire (`ouo-frames/2`-era JSON and the MVP video envelope) and to MVP data types; moving them is a port, not a move, so they are left behind and the kit has a renderer registry with a clear seam for `ouo-frames/3` and `ouo-video/1` (section 6).

## 3. The BFF API

Resource paths, all `GET`, all JSON unless stated, all under `/api/plugins/ouo11y-rum-app/resources/v1`. The version is in the path; a breaking change adds `v2` beside it. Errors are `{"error": "<message>"}` with 400 (bad identifier or time), 403 (Clearance too low), 404, or 502 (a backend failed). Times are milliseconds since the epoch.

| Path | Answer | Needs |
|---|---|---|
| `/me` | `{login, role, level, can: {attributes, replay, identity}}` | any signed-in user; level 0 answers too, so the UI can explain itself |
| `/sessions?from&to&project&limit` | `{sessions: [Session], truncated, redacted: [...]}` | c1 |
| `/projects/{project}/sessions/{session}?from&to` | `{session: Session, events: [Event], replays: [Replay] \| null, redacted: [...]}` | c1 |
| `/projects/{project}/sessions/{session}/replays/{replay}` | The Muninn manifest (spec 7.2), each chunk's `path` rewritten to the BFF's chunk path | c3 |
| `/projects/{project}/sessions/{session}/replays/{replay}/streams/{stream}/chunks/{sequence}` | The chunk's bytes, **decompressed** when its encoding is `gzip`, with `X-Ouo-Replay-Format` | c3 |

Types (Go structs in `ouo-go`, mirrored in `libs/ouo-kit/src/api.ts`):

- `Session`: `project`, `id`, `service`, `start`, `end`, `event_count`, `error_count`, `has_replay` (a hint from Loki reference records, RDR-1), `user` (c4).
- `Event`: `time`, `name`, `severity`, `view_id`, `trace_id`, `span_id`, `attributes` (c2), `body` (c2).
- `Replay`: Muninn's list entry (spec 7.1).
- `redacted`: the names of the field groups Clearance removed from this answer (`attributes`, `replay`, `identity`), so the UI can say "hidden by your clearance" instead of "none".

The BFF decompresses a chunk itself. Muninn serves gzip as stored (MUN-34), and passing `Content-Encoding: gzip` on through Grafana's resource proxy is not something to rely on; more importantly, the BFF is the only place a later Clearance step can look inside a chunk, and it has to decompress to do that. A structure chunk may end in the middle of an event, so the player concatenates the chunks of a segment before parsing ([web replay formats](../../project/kb/client-sdk-web/replay/web-replay-formats.md)).

## 4. Clearance

### 4.1 Levels

A level is an integer from 0 to 5. Each level sees everything the level below sees.

| Level | Sees |
|---|---|
| 0 | Nothing. Every data endpoint answers 403 |
| c1 | Sessions and their event timeline: time, event name, severity, project, service, session id, view id, trace and span ids, counts |
| c2 | Plus every attribute and the body of an event, except identity |
| c3 | Plus replays: the list, the manifest and the chunks |
| c4 | Plus identity: `enduser.*`, `user.*` and `client.address` attributes, and the session's user |
| c5 | The same reads as c4. Reserved for actions that change or export data (delete, export), none of which this slice has |

The capabilities of each level are one table in `ouo-go` (`clearance.go`), so reordering them (Q1) is a one-line change with a test that says what moved.

### 4.2 From a Grafana user to a level

Grafana passes the calling user (login and org role) to the backend with every request. The level is:

1. the user's entry in `clearance.users` (by login), if there is one, else
2. the role's entry in `clearance.roles`, else
3. **0**.

Both maps are in the plugin's settings (`jsonData.clearance`), provisioned like the rest of the plugin. The default when the settings say nothing: `Viewer` c1, `Editor` c3, `Admin` c5; any other role (`None`, an empty role) gets 0. Teams are not in the plugin context Grafana passes; reading them needs a Grafana service account for the plugin and one API call per user (cached), which is the next step (Q2).

### 4.3 Where and how it is enforced

- In `ouo-go`, on every result, before it leaves the library. Every exported read function takes a `Clearance` value; there is no variant without one. Redaction builds a new value from an empty one and copies in what the level allows (deny by default): an attribute is shown only when the level allows attributes and it is not identity, or the level allows identity.
- Replay endpoints refuse with 403 below c3 before any call to Muninn. Below c3 the session answer carries `replays: null` and `redacted: ["replay"]`; the frontend never receives a replay id it could ask for.
- The frontend reads `/me` only to choose what to draw. Nothing it does widens what the BFF returns.

### 4.4 What Clearance cannot do yet

- **It cannot redact inside a recording.** A chunk is shown whole or not at all. Text, inputs and images in an rrweb chunk are as masked as the SDK made them at record time (PRV-5 to PRV-8), no more. Redacting inside a chunk means parsing each format in the BFF; the decompress step of section 3 is the place it will go.
- **It does not find personal data inside values.** Identity is a list of attribute names. A URL or an exception message that contains an email address is shown at c2.
- **It is per Grafana org, not per project.** A user's level applies to every project the plugin can read (Q9).
- **Its configuration is not secret.** Grafana gives every signed-in user the plugin's `jsonData`, so the level map, logins included, is readable by Viewers. It holds no data and no credential; the Muninn token is in `secureJsonData`.
- **It does not cover Grafana's own Explore.** A user who can query the Loki datasource directly sees what Loki holds. Clearance protects the plugin's API; operators restrict the datasources to Admins (or remove them) where that matters (Q3).

## 5. Reaching the stores

**Direct service URLs from the plugin's settings, not Grafana's datasource proxy.** `jsonData.lokiUrl`, `jsonData.muninnUrl`, `jsonData.muninnTenant`, and `secureJsonData.muninnReadToken`. Muninn is not a Grafana datasource at all, so it needs this path regardless; using the same for Loki keeps one way of reaching every store. The datasource proxy with the user's identity would apply Grafana's datasource permissions, but Clearance is the authorization here, the proxy needs a service account and an extra hop, and its permissions are coarser than Clearance (all or nothing per datasource). Rejected for now; it becomes useful when the BFF must run a customer's own datasource (Q3).

**Tenant and project.** The Muninn tenant is one value per plugin instance (`muninnTenant`, default `anonymous`), so one Grafana org reads one tenant, matching one tenant per Collector (COL-9). The project comes from Loki: every session the BFF lists carries its `ouo_project_id` label, and the frontend passes it back in the path. Since Clearance is per org (Q9), a user with c3 may read any project's replays, so the BFF does not look a session up in Loki before it asks Muninn; per-project Clearance will add that check.

Tempo and Mimir are not read in this slice; the session page shows trace ids that link to Grafana's Explore.

## 6. The first slice

Built in this pull request, on the recommendations below:

- `ouo-go`: Loki client (session list, one session's events, replay hint), Muninn client (list, manifest, chunk; gzip handled as in [gzip-on-the-read-path](../../project/kb/muninn/implementation/gzip-on-the-read-path.md)), the Clearance table and redaction, unit tests with a table of levels against fields.
- Plugin backend: the five resource endpoints of section 3.
- `ouo-kit`: `ReplayPlayer` takes a manifest and a chunk fetcher and picks a renderer by format id; `rrweb/2` plays. `ouo-frames/3` and `ouo-video/1` are registry entries that say "not playable here yet"; `ouo-wireframe/1` and unknown formats show as stored but not playable (RDR-2).
- Plugin frontend: Session explorer (list), the session page with its event timeline and the replay beside it.
- `ouo-env up <env> --muninn` provisions the plugin's backend settings; `tests/e2e/plugin-bff/run.mjs` checks the slice end to end.

Not in this slice: Tempo and Mimir views, funnels, dashboards, vendor APIs, GraphQL, Helm values for the new settings, removing rum-api or the MVP pages.

## 7. Founder questions and recommendations

| # | Question | Recommendation |
|---|---|---|
| Q1 | Is the level order right: attributes (c2) below replay (c3) below identity (c4)? | **Yes.** Replay is masked at record time; identity is the field that names a person. Reorder in one table if not |
| Q2 | Map users by org role and per-login overrides now, teams next? | **Yes.** Teams need a plugin service account (Grafana's external service accounts); add it when a pilot customer asks for team-based access |
| Q3 | Direct service URLs, or Grafana's datasource proxy with the user's identity? | **Direct URLs**, with Clearance as the only authorization. Document that the Loki datasource bypasses Clearance and should be Admin-only in a customer's Grafana |
| Q4 | One Muninn tenant per plugin instance (per Grafana org)? | **Yes**, the same as one tenant per Collector |
| Q5 | A new top-level `libs/` for `ouo-go` and `ouo-kit`? | **Yes**, libraries only; the alternative places tie them to a service or to the plugin |
| Q6 | Licence: `ouo-go`, `ouo-kit` and the plugin Apache-2.0; the servers (rum-api, Muninn) AGPL-3.0? | **Yes.** The plugin is what customers install into their Grafana, and the libraries are what they embed |
| Q7 | New pages beside the MVP pages, which are deleted with rum-api? | **Yes.** Porting the MVP pages is a rewrite on a wire they do not read |
| Q8 | Session list from one bounded Loki query (the newest 5000 records in the range, grouped in the BFF)? | **Yes for the pilot**, with `truncated: true` in the answer when the bound was hit. A session index (a summary record per session written at `session.end`, or a recording rule) when lists get slow |
| Q9 | Clearance per project? | **Later.** Per org is honest for one pilot customer per org; per project adds a project dimension to both maps |
| Q10 | Should an unmasked recording (`ouo.replay.masked=false`) need a higher level than a masked one? | **Yes, c5**, in the next slice. It is the one content-level control possible without parsing chunks |

## 8. Consequences

- The plugin ships a Go binary per platform (`gpx_ouo11y-rum-app_linux_amd64`, `_linux_arm64`) next to its JavaScript. Every place that builds the plugin needs Go, or Docker to build it in a `golang` container; the build script does either.
- Grafana starts the backend process; a broken binary disables the whole plugin, MVP pages included, so the stack checks in CI cover the new path too.
- `libs/` appears in the layout, the npm workspaces and the CI Go matrix.
- Clearance is stated in one table, tested as a table, and enforced in one library: a second BFF built on `ouo-go` gets the same rules.
