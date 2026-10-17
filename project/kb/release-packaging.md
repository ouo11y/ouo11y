# Release packaging: npm provenance, GHCR multi-arch, Grafana plugin signing, SwiftPM mirror

What each publishing channel needs and what was checked locally in Phase 8a. Policy
(versions, tags, who bumps what) is in `docs/releasing.md`; this file is the mechanics.

## npm with provenance (`@ouo11y/browser`, `@ouo11y/react-native`)

- `npm publish --provenance` attaches a Sigstore attestation that links the tarball to the
  GitHub Actions run that built it. Requirements, all checked by npm at publish time:
  - runs inside GitHub Actions (or GitLab CI) with `permissions: id-token: write`;
  - the repository is **public** (private repos need npm Pro/Teams and an explicit flag);
  - `repository.url` in `package.json` matches the repo the workflow runs in
    (`git+https://github.com/ouo11y/ouo11y.git`, with `"directory"` for monorepos). Both
    SDK manifests have it since 0.2.0;
  - npm CLI >= 9.5 (Node 24 ships npm 11).
- Scoped packages are private by default; `--access public` (or `publishConfig.access`)
  is needed for the **first** publish of each name. Both are set.
- The `@ouo` scope: an npm organisation named `ouo` must exist and the token owner must be a
  member with publish rights. The scope is not reserved by the repo name.
- Token: a granular access token with "Read and write" on packages, limited to the `@ouo`
  scope, "Bypass 2FA" enabled (otherwise CI publish is blocked by the 2FA requirement). npm
  trusted publishing (OIDC, no token at all) is the better long-term option; it needs the
  package to exist first, so the first release uses `NPM_TOKEN`.
- `npm pack --dry-run -w <workspace>` prints exactly the files that will be published.
  Phase 8a observations:
  - `@ouo11y/browser` 0.2.0 ships `dist/index.js` (136 kB), `dist/index.d.ts` **and a 922 kB
    `dist/index.js.map`** (`files: ["dist", ...]`); `@ouo11y/react-native` likewise ships a
    698 kB map. Fine for debugging; drop `*.map` via `files` negation or tsup `sourcemap`
    if tarball size matters (614 kB and 235 kB packed today).
  - `@ouo11y/react-native` 0.2.0 ships `dist/`, `ios/` (podspecs, Expo module Swift), `android/`
    (stub), `expo-module.config.json`. The iOS sources are synced from `sdk/ios` by
    `scripts/sync-ios.mjs` during `build`, so the tarball never depends on the SwiftPM mirror.
  - `LICENSE*`, `README*`, `CHANGELOG*` and `package.json` are always included by npm
    regardless of `files`; adding `sdk/*/LICENSE` was enough to ship them.
  - `npm pack` without `dist/` built silently produces a 2-file tarball. The release
    workflow builds before packing; do the same locally.
  - The plugin (`private: true`, no `files`) packs its whole source tree; irrelevant because
    the plugin is never published to npm, only zipped from `dist/`.

## GHCR multi-arch images (`rum-api`, `collector`, `grafana`)

- Image names must be lowercase: a GitHub owner like `ZiadMansourM` became `ghcr.io/ziadmansourm/...`; the org `ouo11y` is lowercase already (`ghcr.io/ouo11y/rum-api`).
- `GITHUB_TOKEN` with `packages: write` can push. The first push creates the package
  **private** and unlinked; in the GitHub UI (Packages > package > Package settings) link it
  to the repository, once per package. ouo keeps them private until stable (below).
- **Pulling private GHCR packages.** Anonymous pulls fail with `denied` (HTTP 403); in
  Kubernetes the pod sits in `ImagePullBackOff` with `403 Forbidden` in its events.
  - The owner grants each user access per package: Package settings > Manage access > add
    the GitHub user, role **Read**. Linking the package to the repo can inherit repo access,
    but outside collaborators (clients) still need the per-package grant.
  - The puller uses a **classic** PAT with only `read:packages`; fine grained PATs are not
    supported by the container registry. Log in with
    `echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin`. Inside
    Actions, `GITHUB_TOKEN` of a linked repo can pull without a PAT.
  - Helm: `kubectl create secret docker-registry ghcr --docker-server=ghcr.io
    --docker-username=<github-user> --docker-password="$GHCR_TOKEN" -n <ns>` and
    `imagePullSecrets: [{name: ghcr}]`; the ouo chart applies the list to every pod.
  - No-login alternative: build from source (compose without `compose.images.yaml`; for
    Helm build, push or `kind load`, and override `<component>.image.repository`).
- Multi-arch: `docker/setup-qemu-action` + `docker/setup-buildx-action` +
  `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`. The Go build is
  `CGO_ENABLED=0` on `golang:1.26` and the runtime is `distroless/static-debian12:nonroot`,
  so cross-building is a plain `GOOS=linux` build under emulation; the arm64 leg is slow
  under QEMU (minutes, not seconds) because the Go toolchain itself runs emulated. If it
  becomes a problem, switch the Dockerfile to `--platform=$BUILDPLATFORM` for the build
  stage and pass `TARGETARCH` to `GOARCH` (native cross-compilation, no QEMU).
- `provenance: mode=max` and `sbom: true` on build-push-action publish an attestation
  manifest next to the image; `docker buildx imagetools inspect` shows it. Tools that expect
  a plain manifest list (older `crane`, some Helm chart image scanners) see an extra
  "unknown/unknown" platform entry; that is the attestation, not a broken build.
- `docker/metadata-action` with `type=semver,...,value=<version>` derives `0.2` from `0.2.0`
  and skips `major.minor` for prereleases (`0.2.0-rc.1`). `:latest` is gated on the version
  having no `-`.
- The grafana image (`deploy/images/grafana/Dockerfile`) copies `plugins/ouo11y-rum-app/dist`
  from the repo-root build context; its `Dockerfile.dockerignore` keeps everything else
  out. The workflow builds the plugin first (`npm ci && npm run build -w plugins/ouo11y-rum-app`).
  It sets `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ouo11y-rum-app`, which is harmless once the
  plugin is signed.
- Verified locally: `docker build -t ouo/rum-api:release-check services/rum-api` succeeds
  (6.7 MB compressed, distroless). Multi-arch push was **not** exercised locally (no
  registry); the first tag push is the test.

## Image release pipeline: what was verified on 2026-10-16

Workflow: `release-images.yml` (tag push or `workflow_dispatch` dry run) and the `images`
job of `ci.yml` (every PR). Policy and checklist: `docs/releasing.md`.

- **Cross-compile, do not emulate.** On Docker Desktop without amd64 emulation (Apple
  silicon with Rosetta/QEMU off) any `RUN` in an amd64 stage fails with
  `exec /bin/sh: exec format error`. `collector/Dockerfile` avoids it with
  `FROM --platform=$BUILDPLATFORM golang:1.26` + `GOOS=$TARGETOS GOARCH=$TARGETARCH`
  (amd64+arm64 in ~25 s warm). `services/rum-api/Dockerfile` still builds under emulation;
  a cross-compiling variant built both platforms in ~10 s (handed to the rum-api owner).
  On GitHub runners `setup-qemu-action` makes the emulated build work, only slower.
- **The grafana image needs no emulation** (only `COPY` on top of `grafana/grafana`), but a
  cold multi-arch build pulls the ~300 MB base twice (6 min locally).
- **Version stamping.** The workflow passes `--build-arg VERSION=<semver>` and
  `REVISION=<sha>`; unused build args are ignored, so a Dockerfile opts in by declaring
  `ARG VERSION`. ocb bakes `dist.version` from `builder.yaml` into ouo-collector
  (`ouo-collector --version` printed `0.2.0`), so the workflow checks the tag against
  `builder.yaml` instead of passing ldflags.
- **Annotations.** `docker/metadata-action` emits OCI annotations; set
  `DOCKER_METADATA_ANNOTATIONS_LEVELS: manifest,index` so they land on the multi-arch
  index, which is what the GHCR package page reads (labels live only in each image config).
- **Previous tag for release notes.** `git -c versionsort.suffix=- tag --sort=-v:refname`
  sorts `0.2.0-rc.2` before `0.2.0`; without the suffix setting git sorts the rc after the
  final. Final releases skip rcs so their notes cover everything since the last final.
  Needs `actions/checkout` with `fetch-depth: 0`.
- **GitHub releases in a multi-package repo.** `gh release create --latest=false` so an
  image patch does not become the repository's "Latest release" over an SDK release.
  `--verify-tag` refuses to create a tag implicitly.
- **`if: env.X` sees only workflow/job env.** A step's own `env:` is not visible to its
  `if:`. `release-plugin.yml` checked `env.GRAFANA_ACCESS_POLICY_TOKEN` with the secret set
  nowhere, so signing could never run; the secret is now in the workflow `env`.
- **Compose override to swap builds for images.** `deploy/compose/compose.images.yaml` uses
  `build: !reset null` and `volumes: !override [...]` (Compose >= 2.24; checked with v5.1.1).
  `docker compose ... config` shows only the demo backend still has a `build:`. Verified by
  running the stack on an isolated project (`-p ouo-rel`, shifted ports) from locally built
  images via `OUO_IMAGE_REGISTRY=ouo-local OUO_*_VERSION=check`: `wait-ready.sh` all ready,
  plugin enabled from inside the image, plugin proxy 200, authenticated OTLP 200.
- **Docker inside the agent sandbox.** `docker buildx build` hung at "resolve image config
  for docker/dockerfile:1" when run in the Bash sandbox (registry reachable with curl);
  the same command outside the sandbox worked. Docker Hub also returned an occasional
  `DeadlineExceeded` for the same frontend; a retry fixed it.
- `act` is not installed; `actionlint` (shellcheck included) plus a local run of the
  release-notes shell against a scratch repo with rc and final tags covered the logic.

## Grafana plugin signature levels

Grafana checks `MANIFEST.txt` inside the plugin directory. Three signature levels, all
produced by `npx @grafana/sign-plugin` with a `GRAFANA_ACCESS_POLICY_TOKEN`:

| Level | Who can load it | Needs | Flag |
|---|---|---|---|
| **private** | only Grafana instances whose root URL is in the signature | a grafana.com account, an access policy token (`plugins:write`), the list of root URLs | `--rootUrls https://a.example.com,https://b.example.com` (comma separated, must match `GF_SERVER_ROOT_URL` exactly, scheme and port included) |
| **community** | any Grafana | public source code, open-source licence, Grafana review and listing in the catalog | `--signatureType community` after the plugin is accepted |
| **commercial** | any Grafana | a commercial agreement with Grafana Labs | `--signatureType commercial` |

- Unsigned plugins load only with `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=<id>`; Grafana
  logs a warning on every start and the UI shows "unsigned". This is the documented
  fallback for the pilot (`plugins/ouo11y-rum-app/README.md`).
- `@grafana/sign-plugin` 3.3.3 checked locally (`npx --yes @grafana/sign-plugin`): it has no
  `--help`; running it from the plugin directory looks for `dist/` (override with
  `--distDir`), then aborts with "Missing GRAFANA_ACCESS_POLICY_TOKEN" before touching
  anything. `GRAFANA_API_KEY` is accepted but deprecated. Nothing was signed.
- Private signatures bind the plugin **id and version** to the root URLs: a new plugin
  version needs a new signature, and adding a Grafana instance means re-signing and
  re-releasing. For a multi-tenant pilot keep the list of root URLs in the
  `GRAFANA_ROOT_URLS` repository variable so a re-run of the release workflow re-signs.
- The signed zip layout Grafana expects is `<plugin-id>/plugin.json` at the top level of the
  archive, i.e. `ouo11y-rum-app/...`, which is what `release-plugin.yml` produces from `dist/`.
- `plugin.json` `info.version` is `%VERSION%` in source and is replaced from `package.json`
  at build time; the release workflow checks `dist/plugin.json` carries the tag version.

## SwiftPM: Package.swift must sit at the repository root

- SwiftPM resolves a dependency by cloning a git URL and expects `Package.swift` at the root
  of that clone. There is no sub-path option in `.package(url:)`, so `sdk/ios` cannot be
  consumed from the monorepo URL; local `.package(path: "../../sdk/ios")` works only inside
  the checkout.
- Approach chosen: a mirror repository `ouo11y/ouo11y-ios` whose `main` is
  `git subtree split --prefix=sdk/ios` of this repo, with plain semver tags (`0.2.0`;
  SwiftPM accepts both `0.2.0` and `v0.2.0`). `release-ios.yml` does the split on
  `ios-v*` tags and pushes over SSH with a deploy key. Consumers write
  `.package(url: "https://github.com/ouo11y/ouo11y-ios.git", from: "0.2.0")`.
- `git subtree split` needs the full history (`fetch-depth: 0`) and is deterministic for the
  same history, so successive splits fast-forward each other. Never commit directly on the
  mirror; if someone did, the push is rejected (intentionally not forced) and the fix is to
  reset the mirror's `main` to the latest split by hand.
- `sdk/ios` has no manifest version; the mirror tag is the version. The React Native package
  does not use the mirror at all (it vendors the Swift sources through CocoaPods podspecs
  in `sdk/react-native/ios`), so the mirror only serves native iOS apps.
- Alternative considered: making the monorepo itself a Swift package with a root
  `Package.swift` pointing at `sdk/ios/Sources`. Rejected: every `swift package resolve`
  would clone the whole monorepo including node_modules-free but large docs/report
  history, and the root manifest would need to list every target path.

## Local tooling

- `actionlint` (Homebrew, 1.7.12) validates workflow YAML, expressions and the embedded
  shell via shellcheck. It installs in seconds. macOS has no `timeout`; use the Bash tool
  timeout or `gtimeout` from coreutils.
- GitHub-hosted runners: `macos-latest` has Xcode 16 with Swift Testing, which
  `sdk/ios/test.sh` needs; `ubuntu-latest` has `gh`, `zip`, `docker`, `helm` is added with
  `azure/setup-helm`.
