# 2026-10-16: CI-built, versioned images for rum-api, collector and grafana

Branch `claude/rum-api-release-1026d3`, stacked on `claude/sentry-bridge-design` (PR #16) with
`origin/main` merged in (brings `examples/fast-tracked`, PR #12).

## Done

- **Audit of `release-images.yml`.** Already right: multi-arch (QEMU + buildx), GHCR login with
  `GITHUB_TOKEN`, `:latest` / `:<major.minor>` skipped for pre-releases, SBOM + max provenance,
  GHA cache per image. Missing or wrong, now fixed:
  - no version validation: the tag must be `<image>-v<semver>[-pre]`; for the collector it must
    equal `dist.version` in `collector/builder.yaml` (ocb bakes it into `ouo-collector --version`);
  - no GitHub release: one per tag, notes = image ref + pull command + digest + Grafana base and
    plugin version (grafana) + the changelog section + commits since the previous tag of the
    same image (finals skip rcs), pre-release flag for `-rc.N`, `--latest=false`;
  - no dry run: `workflow_dispatch` with a `tag` input runs every step except login, push and
    release, and writes the notes to the run summary;
  - OCI annotations on the index (GHCR package page), `VERSION` / `REVISION` build args,
    `io.ouo.plugin.version` label on the grafana image, plugin tests before baking it in.
- **`ci.yml`**: the collector job never tested `receiver/ouosentryreceiver`; added. New
  `images` job (matrix rum-api / collector / grafana): builds linux/amd64 from the release
  Dockerfile and context, no push, loads it and smoke-runs it (rum-api usage lists `-check`,
  collector `components` shows ouoreplay/ouosentry and `--version`, grafana image contains the
  plugin's `plugin.json`).
- **`release-plugin.yml`**: the signing step's `if: env.GRAFANA_ACCESS_POLICY_TOKEN != ''`
  could never be true (the secret was not in any env); moved to the workflow `env`.
- **Versioning**: `RELEASING.md` (new, root): how to choose a version, rc rules, image release
  checklist with the founder approval step. `docs/releasing.md`: collector row, dry run, PR
  builds, local checks. First versions: rum-api, collector and grafana images all `0.2.0`
  (matches the Helm chart defaults); `collector/builder.yaml` bumped 0.1.0 -> 0.2.0.
  rum-api 0.2.0 must include the YAML config + S3/MinIO PR; its first rc also waits for that PR (pre-#19 images fail on
  the `-config.file` flag compose.yaml passes after #19). New `collector/CHANGELOG.md` and
  `deploy/images/grafana/CHANGELOG.md`, root `CHANGELOG.md` index updated.
- **Examples**: new `deploy/docker/compose.images.yaml` override swaps the collector and rum-api
  builds and the plugin bind mount for `${OUO_IMAGE_REGISTRY}/<image>:${OUO_<IMAGE>_VERSION}`
  (defaults `ghcr.io/ziadmansourm/ouo`, `0.2.0`); keys documented in
  `deploy/docker/.env.example` (and its inline copy in `examples/fast-tracked/00-stack.md`).
  Build from source = leave the override out; documented in `00-stack.md` Step 3 and Step 5,
  `30-mobile-ios.md` 2.4 and `examples/sentry-mobile/README.md`. Commented placeholder for
  rum-api's `-config.file`, `STORAGE_BACKEND` and `S3_*` keys (taken from the
  rum-api-config-s3 work in progress, to confirm). Helm `values.yaml` repositories now point at
  `ghcr.io/ziadmansourm/ouo/*` (tags unchanged, 0.2.0).

## Verified, and how

- `actionlint` (with shellcheck) clean on all workflows.
- `docker buildx build --platform linux/amd64,linux/arm64`: collector OK, grafana OK
  (plugin built with `npm ci && npm run -w plugins/ouo-rum-app build`), rum-api **fails on
  amd64 locally** (`exec format error`, no emulation on this Docker Desktop). A cross-compiling
  rum-api Dockerfile builds both platforms in ~10 s; handed to the rum-api-config-s3 session
  (shared notes `rum-api-release-to-config-s3.md` + message) because `services/rum-api` is theirs.
  rum-api arm64 alone builds and `-h` lists `-check`.
- `ouo-collector --version` -> `0.2.0`; `components` lists ouoreplay and ouosentry.
- Override: `docker compose -f compose.yaml -f compose.images.yaml config` leaves `build:` only
  on the demo backend; isolated run (`-p ouo-rel`, shifted ports, locally built images through
  `OUO_IMAGE_REGISTRY=ouo-local`, `OUO_*_VERSION=check`): `deploy/scripts/wait-ready.sh` all
  ready, plugin settings `enabled` 0.5.0 from the image, plugin proxy 200, OTLP with the demo
  credential 200, no plugin bind mount. Torn down with `down -v`.
- Release-notes shell run against a scratch repo with rc and final tags: previous-tag selection
  (`0.2.0-rc.2 <- rc.1`, `0.2.0 <- (no previous final)`, `0.2.1 <- 0.2.0`), changelog extraction.
- Not verified: an actual GitHub Actions run (no `act`; the dry run is the first real run), a
  GHCR push, the GitHub release creation.

## Left / next agent must know

- **No tag was pushed.** Ask the founder first, with the exact tags (see the PR). Suggested:
  `collector-v0.2.0` and `grafana-v0.2.0` after this PR and #16 merge; `rum-api-v0.2.0-rc.1` / `0.2.0`
  only after the YAML config + S3 PR (#19) merges. Run the dry run of each tag first.
- After the first push of each image the package is private: the founder sets it public and
  links it to the repo (GitHub > Packages > Package settings).
- Until those images exist, `compose.images.yaml` fails to pull; the docs say to build from
  source in that case.
- rum-api: the Dockerfile cross-compile + `ARG VERSION` / `-X main.version` change is in PR #19
  (commit aaa73bc, no baked ENV on purpose). After #19, compose.yaml and the chart pass
  `-config.file`, so the override needs no rum-api keys (placeholder replaced with a pointer to
  compose.yaml's mounted config and `compose.s3.yaml`), and any rum-api image older than #19
  exits on that flag: no `rum-api-v0.2.0-rc.1` from pre-#19 code. Final keys:
  shared notes `rum-api-config-s3-to-release.md`.
- `deploy/vm/install.sh` still builds from source; an `--images` mode is a follow-up.
- The root `CHANGELOG.md` says plugin 0.3.0 but `plugins/ouo-rum-app/package.json` is 0.5.0
  (grafana-plugin agent).

## Dependencies added

None.
