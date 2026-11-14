# ADR-0026 Debug files upload straight to Muninn; erasure is an operator CLI; rum-api has nothing left

Status: **proposed** (2026-11-14). The founder chose the upload path in discussion on 2026-11-14 and asked for the build; the erasure part (section 5) was built on the defaults of section 7. Amends the proposed ADR-0022 of pull request [#186](https://github.com/ouo11y/ouo11y/pull/186) (storage, lookup and resolution kept; its upload path, section 4 and decision D2, replaced). Amends "all ingest goes through the Collector" (ADR-0019 section 7) by one route, see section 3.

## 1. Context

`services/rum-api` is to be deleted with the MVP leftovers. Its read routes over Loki, Tempo and Muninn (sessions, events, vitals, health, funnels, traces per session) hold no data of their own and move to `ouo-go` readers or to each client's plugin ([ADR-0025](0025-generic-libs-clients-own-plugin-and-access.md)). Two duties hold state that nothing else has (inventory and evidence: [kb](../../project/kb/rum-api-retirement/what-rum-api-still-held.md)):

1. **Debug files and symbolication**: source maps and dSYMs uploaded by the client's CI (`PUT /v1/sourcemaps`, `PUT /v1/dsyms`), and the rewrite of a minified stack on read (`POST /v1/symbolicate`).
2. **Erasure**: delete-by-user and delete-by-project across Muninn, Loki and Tempo, with an append-only audit log (`/v1/admin/*`).

ADR-0019's table left both open ("Decided in Step 9").

## 2. Decision in brief

| Duty | Store | Writer | Reader / runner |
|---|---|---|---|
| Debug files | Muninn, write-once objects keyed by tenant, project, kind, debug id, with release + path pointers (ADR-0022 section 3) | The client's CI, `ouo-sourcemaps upload` / `upload-dsym`, **straight to Muninn's public upload route** | `ouo-go/symbolicate`, on read, in the client's plugin backend |
| Erasure | Muninn `audit/` prefix, create-only objects | `ouo-erase`, a Go CLI the client's operator runs | The same CLI (`ouo-erase audit`) |

No new service. No Collector component for uploads. rum-api is deleted once both exist.

## 3. Upload: one public, write-only route on Muninn

```
PUT /api/v1/projects/{project}/debug-files/{kind}/{debug id}[?release=&file=]
Authorization: Bearer <project upload token>
Content-Encoding: gzip
```

- `kind` is `sourcemap`, `dsym` or (later) `proguard`.
- **Muninn checks the upload token itself.** One secret token per project, held in the client's CI (ADR-0011 section 3). It opens this route only: it never reads, lists or deletes, and the public project token in the bundle never opens it. Compared in constant time.
- **Write-once by content.** Muninn compares the decompressed content: 201 stored; 200 the same content again (whatever the gzip framing); 409 other content under the same debug id, which is a real fault (two different maps claim one build) and fails the CI step.
- **CI gets the store's own answer.** That is the reason it is a direct route: a 2xx means the file is stored, so a build never deploys without its maps by mistake.
- **Only this route is published.** The reverse proxy (Caddy on the VM, the Ingress in Helm) forwards `PUT /api/v1/projects/*/debug-files/*` and nothing else. Muninn's OTLP ingest, reads, deletes and the `audit/` prefix stay on the private network.
- **Limits per kind**, enforced by Muninn on the decompressed size, with the size and SHA-256 recorded in the meta object.

**The amended edge rule:** telemetry (logs, traces, metrics, replay chunks) still enters only through the Collector. The one exception is this write-only, token-protected file route, because a debug file is a build artefact, not telemetry, and its uploader needs a synchronous answer the Collector cannot give.

Rejected: a Collector extension that passes the file on (ADR-0022 D2). It works, but adds a custom component, a second token check and a second hop, to forward a request that has exactly one destination.

## 4. Lookup and resolution: as ADR-0022

- By debug id; a frame without one uses `service.version` + URL path only when exactly one build was uploaded for them, otherwise `ambiguous` and the frame stays as recorded.
- `ouo-go/symbolicate` resolves on read with an LRU of parsed maps; a miss is remembered 60 seconds, so a late upload applies. The record in Loki stays as the SDK sent it. Nothing resolves at ingest.
- dSYM slices are uploaded per `LC_UUID`; the CLI splits a universal file (rum-api did it on the server). R8 retrace is later work.

## 5. Erasure: `ouo-erase` (needs the founder's yes)

A Go CLI in `libs/ouo-go/cmd/ouo-erase`, run by the client's operator with the operator's credentials for Loki, Tempo and Muninn's private API. It ports `services/rum-api/internal/lifecycle/delete.go` and `internal/audit`:

1. Write a `started` audit entry; if it cannot be written, nothing is deleted.
2. Find the user's sessions in Loki (or every session of a project).
3. List their Tempo trace ids before anything is deleted (Tempo cannot delete by attribute; the ids go into the entry for redaction or expiry).
4. Delete their replays through Muninn's delete API (Muninn spec section 8; tombstones are Muninn's durable evidence).
5. Send a Loki delete request.
6. Write a `completed` or `failed` entry with the same id and the counts per backend.

Audit entries are create-only objects under `audit/<tenant>/<project>/<entry id>` in Muninn's bucket (rum-api's S3 backend already works this way; pair it with S3 Object Lock for immutability). `--dry-run` reports what would be deleted.

Why a CLI and not a library call or a service: erasure is an operator action with powerful credentials, run rarely and on request, and the audit trail must not depend on a client's plugin backend existing. A client that wants a button can call the same package from its backend.

## 6. Consequences

- **Muninn** grows the `debug-files/` prefix with four routes (PUT public; file, meta and list private), the upload tokens per project and tenant, a retention per project for debug files (default one year from upload, `0` keeps), `DELETE /api/v1/projects/{project}` (MUN-45), and the create-only `audit/` prefix with two routes. Spec sections 13 and 14.
- **`ouo-sourcemaps`** points `--url` at the public Muninn URL, uses the new path, handles 409, and splits dSYMs itself.
- **`ouo-go`** gains `symbolicate` (dependency `github.com/go-sourcemap/sourcemap`, BSD-2, the parser rum-api uses) and `cmd/ouo-erase`.
- **Deploy** publishes one Muninn route through Caddy and the Helm Ingress once Muninn itself is in the VM install and the Helm chart; today it runs only in the compose stack (`compose.muninn.yaml`), where the CI upload token of the `demo` project is configured.
- Maps uploaded to rum-api are not migrated: CI uploads the next release to Muninn; older releases can be re-uploaded with the same CLI.
- After both land, `services/rum-api` and its plugin pages can be deleted.

## 7. Open

| # | Question | Default if not answered |
|---|---|---|
| O1 | "SDK / CLI targets this public Muninn": only the upload CLI, or should runtime SDK traffic (replay) also go to Muninn directly? | Only the CLI. Runtime telemetry stays on the Collector |
| O2 | Erasure as `ouo-erase` in `libs/ouo-go/cmd/` (section 5) | As written |
