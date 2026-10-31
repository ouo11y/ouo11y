# 2026-10-31 Public images: drop `docker login` from the docs

## Done

The founder made `ghcr.io/ouo11y/{collector,rum-api,grafana}` public on 2026-10-31 for the pilot
program. Every user-facing instruction to `docker login ghcr.io`, create a `read:packages` token,
ask the founder for package access or set `imagePullSecrets` for ghcr is gone or rewritten:
README, `deploy/README.md`, compose files (`.env.example`, `compose.images.yaml`, the generated
`quickstart.yaml` and its template in `gen-quickstart.sh`), `deploy/envs/README.md`, the Helm
README "Pull access" and `values.yaml` comment (`imagePullSecrets` kept, now documented for a
private mirror), `deploy/vm/README.md` and `install.sh` (`--images` help and the 403 message),
`docs/releasing.md` (rule and section 7), `docs/operations/upgrade.md`,
`docs/sentry-bridge-deployment.md`, `examples/fast-tracked/00-stack.md` and `30-mobile-ios.md`, the
example READMEs, and step 4b of the four build-it-yourself guides (now "Check that ghcr.io
answers", same step number so no reference moves). Where a pull can still fail with `denied`, the
docs now say why: an old, expired ghcr.io login in Docker's credential store.

`gen-quickstart.sh` reads digests with `curl` in both modes: `GHCR_TOKEN` when set (CI, unchanged),
otherwise an anonymous pull token. The `docker buildx imagetools` fallback is gone, so writing
the quickstart needs neither Docker credentials nor buildx.

Left as is on purpose: ADR-0009 and the Helm `CHANGELOG.md` 0.1.1 entry (history), the Helm chart
package (`charts/ouo`, never published yet, still private: anonymous token request answers 403),
`SECURITY.md`, the repository's own visibility notes, `project/agents/**`.

## Verified

- `docker manifest inspect ghcr.io/ouo11y/{rum-api,collector,grafana}:latest` with an empty
  `DOCKER_CONFIG`: exit 0, OCI index with linux/amd64 and linux/arm64 for all three.
- `curl -u user:bad 'https://ghcr.io/token?scope=repository:ouo11y/rum-api:pull'` answers 403
  (the stale-login case the docs describe); anonymous answers a token.
- `deploy/scripts/gen-quickstart.sh --check`, `--check --verify-digests` without `GHCR_TOKEN`
  (anonymous) and with a token, and a write run that reproduces the committed file. A tag that does
  not exist makes `registry_digest` fail (404).
- `node examples/quickstarts/check-embeds.mjs` in sync (after `--write` for the tiny-shop guide).
- `lychee --offline` (CI's command): 0 errors. `shellcheck` on both touched scripts: clean.
  `helm lint deploy/helm/ouo -f deploy/helm/ouo/values-kind.yaml`: 0 failed.

## Next

- If a new image package is released, the founder makes it public too (docs/releasing.md step 7).
- When the chart package is first published, decide its visibility; docs/releasing.md section 7
  still describes the private chart login.
