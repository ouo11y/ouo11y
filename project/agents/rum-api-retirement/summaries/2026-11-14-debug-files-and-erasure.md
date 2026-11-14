# 2026-11-14 Debug files and erasure out of rum-api

Branch `claude/rum-api-leftovers-33b874`. Decision: [ADR-0026](../../../../docs/adr/0026-debug-files-and-erasure-without-rum-api.md) (proposed). Inventory: [kb](../../../kb/rum-api-retirement/what-rum-api-still-held.md).

## What was done

- **Muninn** (spec sections 13, 14, MUN-45): `PUT /api/v1/projects/{p}/debug-files/{kind}/{id}` opened only by a per-project upload token (`debug_files.upload_tokens`, tenant from the token, not the header); write-once by decompressed content (201 / 200 / 409); release + path pointers; private reads of file, meta and lists; `DELETE /api/v1/projects/{p}`; create-only audit entries; debug-file retention (one year) in the sweeper; 10-minute deadlines on an upload. The compose stack has the `demo` upload token.
- **`libs/ouo-go`**: `Muninn.DebugFile` / `DebugFileIDs`; `symbolicate` (debug id or exactly-one-build fallback, LRU, 60 s miss memory, Hermes, dSYM slices), ported from PR #186's prototype and rum-api; `Muninn.DeleteSessionReplays` / `DeleteProject` / `PutAudit` / `Audit`; `erase` and `cmd/ouo-erase`, ported from rum-api's lifecycle and audit code. New dependency: `github.com/go-sourcemap/sourcemap` v2.1.4 (BSD-2, no transitive dependencies; the parser rum-api uses).
- **`sdk/sourcemaps`**: uploads to Muninn's route; `--project` is required (breaking); 409 fails the step; dSYMs are split into slices and keyed by `LC_UUID` in the CLI; fixtures copied out of rum-api.
- **ouo-web**: uploads to Muninn when the stack runs it (`OUO_MUNINN_URL`), otherwise deletes the maps unuploaded; verify checks the debug id and, with Muninn, the stored map. rum-api's symbolication check is gone.
- Docs: `docs/sourcemaps.md`, `docs/symbolication.md`, `docs/operations/data-lifecycle.md` (an `ouo-erase` part), Helm README, Muninn README and config example.

## Verified, and how

- `cd services/muninn && go vet ./... && go test -race ./...`; `cd libs/ouo-go && go vet ./... && go test -race -count=1 ./...`; `npm run typecheck && npm test` in `sdk/sourcemaps` (36 tests). All pass.
- Live on ouo-env `rum-api-leftovers-33b874` (`--muninn`, MinIO store):
  - curl: upload token 201, read token 401 on the upload route, same content plain 200, other content 409, read back, pointer list.
  - `examples/ouo-web/scripts/run.sh --env rum-api-leftovers-33b874`: the CLI uploaded 3/3 maps; 38/38 checks, including "the bundle's source map is stored in Muninn under its debug id".
  - A throwaway program (ouo-go `Loki.SessionEvents` + `symbolicate.FromEvent` + `Resolver.Resolve` against that Muninn) resolved the real render error 10/10 frames: `at $_ (…/index-ssossojE.js:12:6917)` to `at RenderBomb (src/components/ChaosPanel.tsx:18:20)` with its source line.
  - `ouo-erase user erase-probe-nobody`: started and completed records in Muninn, read back with `ouo-erase audit`; real Loki accepted the delete request `… | enduser_id="…" or user_id="…"` (status `received`). Whether that filter deletes the right lines was not checked (it waits for the compactor's cancel period).
  - `tests/e2e/muninn/run.mjs`: 25/25.

## Not done / next

- Muninn is not in the VM install or the Helm chart, so no Caddy or Ingress rule publishes the upload route yet; the Helm README says so.
- Deleting `services/rum-api`, its plugin pages, `OUO_UPLOAD_TOKENS`, and the rum-api text in docs.
- Erase choices that differ from rum-api (from the porting agent): user matched on `enduser_id` or `user_id`; sessions grouped by project; a project erase does not look up sessions in Loki (so a project dry run cannot count replays); a Tempo lookup failure makes the run `failed`; a stored record over 64 KiB is trimmed with `truncated: true`; no `ouo.deletions` metrics.
- `@ouo11y/sourcemaps` needs a release (breaking: `--project`).
- The env `rum-api-leftovers-33b874` is still up: `http://grafana.rum-api-leftovers-33b874.ouo.localhost`. Tear down with `deploy/envs/ouo-env down rum-api-leftovers-33b874`.
