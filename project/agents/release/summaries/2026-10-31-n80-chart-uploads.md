# 2026-10-31: N80, chart documentation for source map and dSYM uploads

## Done

- `deploy/helm/ouo/README.md`, section "Source maps and dSYMs: upload tokens": project upload
  tokens reach rum-api as `OUO_UPLOAD_TOKENS` from a Secret through `rumApi.extraEnv` (example
  Secret and values), rollout notes, and uploads only from inside the cluster (ClusterIP): a
  port-forward example (`inject`, `upload`, the forward stopped by PID) and the in-cluster URL.
  `values.yaml` and `docs/sourcemaps.md` point at it.
- Checklist N80 says what is left: an optional `upload-tokens` key in the rum-api Secret (a
  `feat(chart)`, so a chart release) and the public upload path (N41).

`docs(chart)` on purpose: it works with chart 0.2.0 as published, so no chart release.

## Verified

- `helm lint` and `helm template` with the README example as values: `OUO_UPLOAD_TOKENS` from
  the Secret on the rum-api container; Service `ouo-rum-api`, port 8080.
- The rendered config with `OUO_UPLOAD_TOKENS` passes `rum-api:0.6.0 -config.verify` (token
  redacted); a token under 16 characters is refused.
- Reviewer session (PR #136) also ran rum-api 0.6.0 with that config: 401 without tokens or with
  a wrong one, 201 for an upload with the right token.

No env was started; nothing is left running.
