# 2026-10-17: pull access for the private GHCR images

## Why

The 0.2.0 images (`ghcr.io/ziadmansourm/ouo/{collector,rum-api,grafana}`) stay private until
ouo reaches a stable version (founder decision 2026-10-17). No doc said so, so anyone following
the examples (two prospective clients included) hit a bare `denied` / 403 on the first pull.

## What changed (docs only)

- `examples/fast-tracked/00-stack.md`: new "Pull access" subsection at the top of Step 3 (ask the
  founder for Read on the three packages, classic PAT with only `read:packages`,
  `echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin`, a check pull,
  build from source as the no-login path); a pointer under the image version table.
- `examples/fast-tracked/30-mobile-ios.md`, `examples/sentry-mobile/README.md`: the login
  command before the `compose.images.yaml` start, with a pointer to 00-stack.
- `deploy/README.md`: "Released images instead of builds" paragraph with the login.
- `deploy/compose/compose.images.yaml`, `deploy/compose/.env.example`: header comments.
- `deploy/helm/ouo/values.yaml`: comment above `imagePullSecrets` (Secret `ghcr`);
  `deploy/helm/ouo/README.md`: "Pull access" subsection (create the `docker-registry` Secret,
  `--set 'imagePullSecrets[0].name=ghcr'`, no-access alternative) and the values table row.
- `docs/releasing.md`: "Pull access" section (how the founder grants Read per package, what a new
  user asks for, Helm, build from source); checklist steps 6 and 8 no longer say to make the
  package public. `docs/releasing.md` secrets table and `docs/operations/upgrade.md` updated
  the same way.
- `project/kb-archive/release-packaging.md` + `project/kb-archive/index.md`: private-package pull quirks.

No token or real credential anywhere; every example uses `$GHCR_TOKEN` and `<github-user>`.

## Verified

- `helm lint deploy/helm/ouo` passes; `helm template` with `--set 'imagePullSecrets[0].name=ghcr'`
  renders the secret on all 6 pod specs (collector, rum-api, Grafana, Loki, Tempo, Mimir).
- Not verified: an actual login/pull against the private packages (needs a granted account and
  token) and that fine-grained PATs are still rejected by ghcr.io (from GitHub docs, not tested).

## Next

- When the packages go public, remove the "Pull access" sections (grep `read:packages`).
- No dependency added.
