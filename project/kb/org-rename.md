# Renaming the org: what changes and what bites (ouo -> ouo11y, 2026-10-18)

Learned doing the ADR-0009 rename. Reuse it for any later rename of a package, plugin ID, image path or repo.

## What to rewrite and what to leave

- Rewrite live files only: code, configs, workflows, Helm, compose, READMEs, specs, kb, trackers, indexes.
- Leave history as written: dated agent summaries, HTML verification reports, CHANGELOG entries of released versions, and ADRs other than the one deciding the rename (only fix their folder paths). Each CHANGELOG gets a new Unreleased line instead.
- Leave recorded fixtures as captured: `services/rum-api/internal/session/testdata/*.json` are real Loki rows with `scope_name: @ouo/browser`. rum-api does not key on the SDK name or scope name (it only lists them as noise fields in `internal/session/event.go`), so old and new data parse the same.
- A regex script with word-boundary guards did the bulk (169 files). Order matters: `ZiadMansourM/ouo-ios` before `ZiadMansourM/ouo`, and `raw.githubusercontent.com/...` before `github.com/...`. Then grep the excluded paths and fix by hand.

## Things that are not a plain search and replace

- **Go:** module paths change in `go.mod`, every import, the collector's `builder.yaml` (`dist.module`, `gomod:` lines and `replaces:`), and the mdatagen output `internal/metadata/generated_status.go` (`ScopeName` is the module path, so the collector's self-telemetry scope name changes too). `go mod tidy` in each module, then `builder --config builder.yaml` and `ouo-collector components` show the new paths.
- **npm:** after renaming `name` in a workspace package, `npm install` at the root rewrites `package-lock.json` (the `node_modules/@scope/name` links); the separate locks of `examples/mobile` and `examples/sentry-mobile` reference the SDK by `file:` and only need the text rename. The SDK name is also the OTel instrumentation scope name and `ouo.sdk.name` (`src/version.ts`), so it shows in stored telemetry.
- **Grafana plugin ID:** Grafana keys pages (`/a/<id>/...`), the proxy (`/api/plugin-proxy/<id>/...`), settings (`/api/plugins/<id>/settings`), the unsigned allow-list and the sandbox opt-out on the ID. A new ID is a new plugin: settings are not carried over (provisioning re-creates them), old links 404, and the old folder (Helm copies plugins to a PVC) is left behind and refused as unsigned. Bump the plugin version, since the ID change is breaking.
- **SwiftPM:** the identity apps write in `.product(name:, package:)` is the last component of the URL or path, not `Package.swift`'s `name`. `package: "ouo11y-ios"` works for the mirror URL; for `.package(path: ".../sdk/ios")` it is `package: "ios"`. Verified with a scratch consumer package (`unknown package 'ouo11y-ios' ... valid packages are: 'ios'`).
- **Images:** released tags stay under the old path. Pins that name the new registry break until the next release; say so in `compose.images.yaml` and `docs/releasing.md`. New GHCR packages under an org need the org to allow package creation, and per-package Read grants do not carry over.
- **Mirror repos written by CI with fast-forward pushes:** do not put a README commit on `main` of an empty mirror, or the first `git push mirror <split>:refs/heads/main` is rejected. Put it on another default branch (`about`) and switch the default after the first publish.

## Moving material to another repo with history

```bash
git clone --no-local --branch main <product-url> company && cd company
git filter-repo --force --path docs/business/ --path reports/roadmap.html --path project/reports/roadmap.html \
  --path-rename docs/business/: --path-rename project/reports/roadmap.html:reports/roadmap.html
```

List every path the files ever had (`git log --follow --name-only --format= -- <file> | sort -u`) and pass each with `--path`, or the history before a move is lost. Relative links into the old repo become URLs. Removing the files from the product repo afterwards does not remove them from its history (checklist N20).

## Verifying

`go test ./...` per module (rum-api's S3 tests need MinIO: run `pgsty/minio` yourself and set `OUO_TEST_S3_ENDPOINT` when Docker Hub pulls time out), `npm run build/test --workspaces`, `node --test deploy/envs/*.test.mjs`, `npm pack --dry-run` for both SDKs, the ocb build plus `validate`, `swift build` and `sdk/ios/test.sh`, `helm lint`, lychee offline, then `ouo-env up`, `deploy/scripts/smoke.sh`, and the plugin's settings, proxy and `/a/<id>/overview` page under the new ID.
