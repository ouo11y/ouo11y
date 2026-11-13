# Prototype: debug-file store and stack resolver (ADR-0022)

A working model of [ADR-0022](../../../../docs/adr/0022-debug-files-without-rum-api.md) for web source maps. It is not wired into rum-api, the plugin or the Collector, and it is not in CI's Go module list.

| Path | What it is |
|---|---|
| `debugfiles/` | The store: write-once files on disk keyed by tenant, project, kind and debug id, release pointers, the REST API proposed for Muninn, the client `ouo-go` would hold, and a stand-in for the Collector's upload route |
| `symbolicate/` | The resolver, shaped like the future `ouo-go` library. `stack.go` and `helpers.go` are copies from `services/rum-api/internal/sourcemap`; `resolver.go` is the new lookup and cache |
| `cmd/ouo-symdemo/` | `serve` (store and upload route), `resolve` (one stack), `measure` (the report's numbers) |
| `demo/capture.mjs` | Loads a built ouo-web in headless Chromium and saves the exception record `@ouo11y/browser` sends |
| `demo/run.sh` | The whole demo: build, inject, capture, upload with `ouo-sourcemaps`, resolve, measure |
| `demo/results/` | What the run of 2026-11-13 produced: the minified stack, its debug ids, the resolved result, the measurements |

```bash
cd project/agents/symbolication/prototype && go vet ./... && go test ./...
project/agents/symbolication/prototype/demo/run.sh      # from the repo root, after npm ci; about two minutes
```

The tests cover: resolve by debug id, write-once (201, 200, 409, 401), a missing map and a late upload, the release fallback (match, wrong release, other project, two builds, unknown debug id), garbage uploaded as a map, and rum-api's Hermes fixture with two OTA bundles.

Dependency: `github.com/go-sourcemap/sourcemap` v2.1.4, the parser rum-api uses today.
