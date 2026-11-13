# 2026-11-13: source maps without rum-api, design and prototype

## What was done

- Read `services/rum-api/internal/sourcemap`, `sdk/sourcemaps`, the plugin's `StackTrace` component, ADR-0011, the archived kb on source maps, Hermes and dSYM, and the Collector-to-Muninn design (ADR-0019 and `docs/specs/muninn.md` on its open branch).
- Proposed [ADR-0022](../../../../docs/adr/0022-debug-files-without-rum-api.md): debug files are write-once, opaque files in Muninn keyed by tenant, project, kind and debug id; the CLI uploads through a pass-through route on the Collector; `ouo-go` resolves a stack when the BFF serves an error; lookup by debug id, release + path only when exactly one build matches.
- Built a prototype under [prototype/](../prototype/README.md): the store with the REST API proposed for Muninn, a stand-in for the Collector route, the resolver, and a demo that builds ouo-web minified, captures a real exception from `@ouo11y/browser` 0.4.0 in headless Chromium, uploads the maps with the unchanged `ouo-sourcemaps` CLI and resolves the stack.
- Wrote the [report](../reports/source-maps-without-rum-api.html) and the kb entries in [project/kb/symbolication/](../../../kb/symbolication/index.md).

## What was verified, and how

- `go vet ./... && go test ./...` in `prototype/`: pass. Six tests: resolve by debug id, write-once (201, 200, 409, 401), missing map then late upload, release fallback (match, wrong release, other project, two builds, unknown debug id), garbage upload, Hermes with two OTA bundles (rum-api's fixture).
- `prototype/demo/run.sh` end to end: the captured stack `at $_ (…/index-CGNPO9Y4.js:12:6894)` resolves to `at RenderBomb (src/components/ChaosPanel.tsx:18:20)`, 10 of 10 frames mapped.
- Measurements (`ouo-symdemo measure`, Apple M5): cold resolve 18.9 ms median for the 1.12 MB map (30 runs), 592 ms for a 33.6 MB map (10 runs); warm 0.28 ms and 0.59 ms; heap kept 3.0 MB and 64.5 MB; stored 296 KB and 7.3 MB; a missing map 0.27 ms cold. Raw numbers in `prototype/demo/results/measurements.json`.
- Vendor facts were checked against documentation and public source by one research pass; what could not be verified is marked in the kb entry.
- `lychee --offline` clean.

## Not verified

- S3 or MinIO as the backend, a real Collector in front of the store, a React Native app on a device, dSYMs in the new store. Ingest-time resolution was not built (same library; the difference is behaviour, described in the ADR).
- The prototype module is not in CI's Go matrix (`ci.yml` lists its modules). `security.yml` runs govulncheck on every `go.mod`, so it does scan this one.

## Dependencies

- `github.com/go-sourcemap/sourcemap` v2.1.4 in the prototype module: the source-map parser rum-api already uses. Nothing else added.

## What is left

- The founder's decisions D1 to D6 in the ADR.
- Then: Muninn's debug-file routes, the Collector upload route, `ouo-go/symbolicate` (move of rum-api's package plus the new lookup), two CLI changes (409 as already stored; dSYM slices split in the CLI), and the docs that name rum-api.

## What the next session must know

- No env was started; nothing is left running. The demo starts one process (`ouo-symdemo serve`) and stops it by PID.
- `stack.go` and `helpers.go` in the prototype are copies from rum-api. When `ouo-go` exists, move the originals and delete the prototype.
- Maps stored in rum-api today are not migrated by this design: CI uploads the next release to the new path.
- ADR-0019 (Muninn) is still an open pull request. If D1 is accepted, its spec needs a debug-file section; this work did not edit it.
