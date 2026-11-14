# What rum-api still held on 2026-11-14

Checked on `main` at `94eaf46d` by reading the code. Decision built on it: [ADR-0026](../../../docs/adr/0026-debug-files-and-erasure-without-rum-api.md).

## Routes and whether they hold data

Routes are in `services/rum-api/internal/httpapi/server.go` (`Handler`).

| Routes | Holds data? | Goes to |
|---|---|---|
| `POST /v1/replay/chunks`, `/v1/sessions/{id}/replay*` | Yes, the MVP replay store | Removed; Muninn replaces it (ADR-0019) |
| `/v1/sessions`, `/v1/sessions/{id}`, `/logs`, `/vitals`, `/traces`, `/v1/stats/health` | No: reads Loki and Tempo | `ouo-go` readers (`Loki.ListSessions`, `SessionEvents`, raw LogQL) or the client's plugin |
| `/v1/funnels/*` | No: computed from Loki events, 60 s in-memory cache only (`docs/specs/funnels.md`) | A query over `ouo-go`'s Loki reader, if a client wants funnels |
| `PUT /v1/sourcemaps`, `PUT /v1/dsyms`, `GET /v1/sourcemaps`, `POST /v1/symbolicate` | **Yes: uploaded debug files** | Muninn debug-file objects + `ouo-go/symbolicate` |
| `DELETE /v1/admin/users/{user}`, `DELETE /v1/admin/projects/{project}`, `GET /v1/admin/audit`, `POST /v1/admin/retention/sweep` | **Yes: the deletion audit log** (the sweep was replay retention, now Muninn's) | `ouo-erase` CLI + `audit/` objects in Muninn |

## Debug files

- **Writer:** the client's CI, never the SDK. `ouo-sourcemaps upload` PUTs every map and `upload-dsym` every DWARF slice (`sdk/sourcemaps/src/cli.ts`, usage text), with a secret per-project upload token (`internal/httpapi/sourcemaps.go`, `uploadProject`).
- **At runtime** the SDK only sends `ouo.exception.debug_ids`, script URL to debug id (`sdk/browser/src/signals/errors.ts`; React Native `sdk/react-native/src/errors/debugids.ts`).
- **Key:** per project, then per built bundle file by debug id; release + URL path as a second index (`internal/sourcemap/store.go`, `debugIDKey` / `releaseKey`). dSYMs per architecture slice by `LC_UUID` (`internal/sourcemap/dsym.go`, `dsymKey`). No tenant in the key.
- **Same release, new build:** with debug ids the new build has a new id, so frames stay right. Without ids, rum-api's release index keeps the last upload, so an older build's errors get the newer map: wrong frames. ADR-0022 answers `ambiguous` instead when a release + path has more than one build.
- Vendors (Sentry, Datadog, PostHog, Alloy's `faro.receiver`): see PR #186's `project/kb/symbolication/vendors/` entry. All key by a build id with release + path as a fallback; all resolve at ingest because they group issues there.

## Erasure

- `internal/lifecycle/delete.go`, `DeleteUser`: writes a `started` audit entry, finds the user's sessions in Loki, lists their Tempo trace ids (Tempo 3.0 cannot delete by attribute), deletes their replays, sends a Loki delete request, writes `completed` / `failed`.
- `internal/audit/audit.go`: JSON Lines with a SHA-256 chain on disk, or one create-only object per entry on S3.
- Muninn's own delete API removes one session's or one replay's chunks and leaves delete-by-user to the caller (`docs/specs/muninn.md`, section 8).

## Where they went (built 2026-11-14)

- Debug files: Muninn spec section 13; `libs/ouo-go` `DebugFile`, `DebugFileIDs`, `symbolicate`; `ouo-sourcemaps` uploads there. Muninn compares the decompressed content, so the same map gzipped by another zlib is a 200, not a 409.
- Erasure: `libs/ouo-go/erase`, `cmd/ouo-erase`, audit records in Muninn (spec section 14), project delete MUN-45.
- Loki's delete API accepts a label filter with `or` (`| enduser_id="u" or user_id="u"`), checked against the compose stack's Loki; it validates the query when the request is created.
- A Muninn route behind `http.ResponseController` deadlines needs its wrapping writer to `Unwrap()`, or the deadline calls fail silently.
