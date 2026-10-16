# Releasing ouo

The short version: how to pick a version, how pre-releases work, and the checklist for
cutting a container image release (`rum-api`, `collector`, `grafana`). The full policy for
every package (npm SDKs, Swift package, plugin zip, Helm chart) is
[docs/releasing.md](docs/releasing.md); workflow mechanics and tool quirks are in
[kb/release-packaging.md](kb/release-packaging.md).

**Nobody pushes a release tag without the founder's explicit yes**, with the exact tag
names and what they publish written down first. Tags and published images are permanent.

## Choosing a version

Every package has its own [semantic version](https://semver.org); the tag is
`<package>-v<version>`. While the major version is 0:

| Change since the last release | Bump | Example |
|---|---|---|
| anything a user or operator can see: new config key, env var, API route, attribute, changed default, dropped support, a stored-data schema change | minor | `0.2.0` -> `0.3.0` |
| a breaking change (also minor while 0.x, listed under **Breaking** in the changelog) | minor | `0.3.0` -> `0.4.0` |
| fixes and internal changes, no visible behaviour change | patch | `0.3.0` -> `0.3.1` |

Image-specific rules:

- **rum-api**: version = the tag. The first release is `0.2.0` and **must contain the YAML
  config file and S3 / MinIO replay storage** (the rum-api-config-s3 work); do not tag
  `rum-api-v0.2.0` before that PR is merged.
- **collector**: version = `dist.version` in `collector/builder.yaml`; the workflow refuses a
  tag that differs. Bump it in the PR that changes the collector. First release `0.2.0`.
- **grafana**: its own series; the release notes name the Grafana base image and the
  `ouo-rum-app` plugin version baked in. Any plugin release that should reach image users
  needs a grafana image release too. First release `0.2.0`.

The `0.2.0` starting point matches the Helm chart defaults (`deploy/helm/ouo/values.yaml`)
and the examples (`deploy/docker/.env.example`).

## Pre-releases (`-rc.N`)

- `<version>-rc.1`, `-rc.2`, ... are candidates for `<version>`. Tag them from any commit
  on `main` (or a release branch) that should be tried by someone outside the repo, e.g. a
  pilot client, before the final.
- They publish `:<version>-rc.N` only. They never move `:latest` or `:<major>.<minor>`,
  and the GitHub release is marked pre-release.
- An rc may be cut before every planned feature has landed when a client needs something
  runnable now; say what is missing in its release notes. Example: `rum-api-v0.2.0-rc.1`
  from today's code (no YAML config / S3 yet), `-rc.2` after that PR, then `0.2.0`.
- The final is tagged on the same commit as the last rc whenever possible (no new code
  between "verified" and "released").
- Examples and docs pin finals. Point an example at an rc only on a branch.

## Checklist: container image release

Before the tag:

1. [ ] The change is merged to `main`, CI green, including the `image (<name>)` jobs.
2. [ ] Changelog: move `## Unreleased` to `## <version> (<date>)` in
   `services/rum-api/CHANGELOG.md`, `collector/CHANGELOG.md` or
   `deploy/images/grafana/CHANGELOG.md`; update the row in the root `CHANGELOG.md`.
   (rcs may skip this; the notes then list the commits only.)
3. [ ] collector only: `collector/builder.yaml` `dist.version` equals the version.
4. [ ] Local checks (docs/releasing.md section 5) and `actionlint`.
5. [ ] Dry run: GitHub > Actions > `release-images` > Run workflow on `main` with the exact
   tag, e.g. `rum-api-v0.2.0`. It builds amd64 + arm64, checks the version and prints the
   release notes in the run summary; nothing is pushed.
6. [ ] Ask the founder in chat: exact tag names, the image refs they create
   (`ghcr.io/ziadmansourm/ouo/<image>:<version>` plus `:<major>.<minor>` and `:latest` for
   a final), and whether a package becomes public. Wait for yes.

Tag:

```bash
git switch main && git pull --ff-only
```

```bash
git tag -a rum-api-v0.2.0 -m "rum-api 0.2.0"
```

```bash
git push origin rum-api-v0.2.0
```

After the tag:

7. [ ] The `release-images` run is green; its summary lists the pushed tags and digest.
8. [ ] First release of an image only: GitHub > Packages > the package > Package settings:
   connect it to the repository and set visibility **public** (founder decision), or every
   `docker pull` needs a login.
9. [ ] `docker buildx imagetools inspect ghcr.io/ziadmansourm/ouo/<image>:<version>` shows
   `linux/amd64` and `linux/arm64` (plus `unknown/unknown` attestation entries).
10. [ ] Bump the pins that should follow: `deploy/docker/.env.example` and the defaults in
    `deploy/docker/compose.images.yaml`, `deploy/helm/ouo/values.yaml` (chart patch bump),
    the version table in `examples/fast-tracked/00-stack.md`.
11. [ ] Run the stack from the released images and record it (release trains table in
    `CHANGELOG.md`):

    ```bash
    docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.images.yaml up -d
    ```

A broken release is fixed by a new patch version (or the next rc). Never move or delete a
pushed tag and never overwrite a published image tag.
