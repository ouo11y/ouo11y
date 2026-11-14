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

## After review (2026-11-15, PR #197)

The second session's review asked for changes; all are in:

1. **Admin token.** Muninn's `auth.admin_token` (`MUNINN_ADMIN_TOKEN`) alone opens `DELETE /api/v1/projects/{p}` and both audit routes. The read token, held by plugin backends, gets 401 there; the admin token also opens every read. Unset, those routes are closed. The config rejects an admin token equal to the read or ingest token, and an upload token equal to any of them. `ouogo.Muninn.AdminToken`; `ouo-erase` reads only `MUNINN_ADMIN_TOKEN` and gives Muninn 30 minutes.
2. **MUN-45 counts.** `replays` counts replays that were live, not tombstoned ones; `debug_files` counts bodies, not their meta, pointers or `.seen`. A second delete answers zeros.
3. **Tamper evidence** is stated in ADR-0026 section 5, spec AUD-2 and data-lifecycle: only S3 with Object Lock; the filesystem backend has none, where rum-api's had a hash chain.
4. **Re-upload restarts retention**, as rum-api did: a 200 overwrites `<id>.seen`, and the sweeper counts from the newer of the body and `.seen`. The file itself stays write-once.
5. **At most 4 uploads at once** per Muninn; the fifth gets 503 with `Retry-After: 10` before its body is read. The CLI retries a 503 up to four times.
6. **Project delete** gets a 10-minute write deadline; data-lifecycle says to rerun after a timeout.
7. ADR audit key path fixed to `audit/<tenant>/<entry>/<status>.json`.
8. **`erase.Tempo` removed**; `erase` uses #196's `ouogo.Tempo` through a new `Tempo.TraceIDs`, and skips sessions that are not 32 hex (none of the SDKs or the bridge send one).
9. Rebased on #196 (two index-row conflicts).

Not changed: a user erase removes only lines that carry `enduser_id` / `user_id`; lines from before `identify()` stay, as in rum-api. Deleting by the found sessions' `session_id` would close that gap; it is a founder decision, listed below.

CI fix found along the way: `stack-env.sh` sets `OUO_MUNINN_URL` before CI starts Muninn, so `run.sh` now uploads only when Muninn answers `/ready`.

Verified: Muninn `go test -race` with new tests (admin token on delete and audit, exact counts, live-only replay count, upload cap, re-upload keeps a 400-day-old file and the sweep a year later removes all its objects, distinct tokens); `ouo-go` `go test -race` with `Tempo.TraceIDs`; `sdk/sourcemaps` vitest 37/37 with the 503 retry.

## Not done / next

- Muninn is not in the VM install or the Helm chart, so no Caddy or Ingress rule publishes the upload route yet; the Helm README says so.
- Deleting `services/rum-api`, its plugin pages, `OUO_UPLOAD_TOKENS`, and the rum-api text in docs.
- Erase choices that differ from rum-api (from the porting agent): user matched on `enduser_id` or `user_id`; sessions grouped by project; a project erase does not look up sessions in Loki (so a project dry run cannot count replays); a Tempo lookup failure makes the run `failed`; a stored record over 64 KiB is trimmed with `truncated: true`; no `ouo.deletions` metrics.
- Founder decision: also delete a user's pre-`identify()` lines by the found sessions' `session_id`.
- `@ouo11y/sourcemaps` needs a release (breaking: `--project`).
- The env `rum-api-leftovers-33b874` is still up: `http://grafana.rum-api-leftovers-33b874.ouo.localhost`. Tear down with `deploy/envs/ouo-env down rum-api-leftovers-33b874`.
