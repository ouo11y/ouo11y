# Upgrading ouo

Operator procedure for moving an installation from one release to the next, for the Docker
Compose path (laptop and the VM install under `deploy/vm/`) and the Helm path. Versioning
and tag names are in `docs/releasing.md`; this document assumes the images and packages of
the target release already exist.

Status: procedure written in Phase 8a. The schema-version guard in section 4 is a
**requirement**, not yet implemented in rum-api; the qa agent tests it once it lands.

## 1. Before any upgrade

1. Read the per-package changelogs for every version you are skipping over, especially the
   `Breaking` and `Compatibility` headings (`CHANGELOG.md` at the root links them all).
2. Check the compatibility table in section 5. Upgrade in this order when more than one
   component changes: **rum-api first, then Grafana image / plugin, then SDKs**. rum-api is
   backwards compatible with the previous SDK minor; SDKs are not forwards compatible with
   an older rum-api.
3. Back up what cannot be rebuilt: the rum-api data directory (replay chunks and
   `meta.json` files), the Grafana database (dashboards, service accounts, plugin settings),
   and the project registry file if you use `OUO_PROJECTS_FILE`. Loki, Tempo and Mimir data
   are telemetry; back them up according to your retention needs (Phase 8c drill).
4. Note the running versions so you can roll back:
   - compose: `docker compose -f deploy/compose/compose.yaml images`
   - Helm: `helm history ouo -n <namespace>` and `helm get values ouo -n <namespace>`

## 2. Compose path (laptop, VM install)

The compose stack builds `rum-api` and the demo backend from source and bind-mounts the
plugin `dist/`; upgrading means checking out the release and rebuilding.

```bash
cd <checkout>
git fetch --tags
git checkout rum-api-v<new>            # the release tag of the component you upgrade; for a
                                       # full upgrade use the release-train commit from CHANGELOG.md
npm ci && npm run -w plugins/ouo-rum-app build   # plugin dist that Grafana mounts
docker compose -f deploy/compose/compose.yaml pull     # Grafana, Loki, Tempo, Mimir, collector tags
docker compose -f deploy/compose/compose.yaml build rum-api backend
docker compose -f deploy/compose/compose.yaml up -d    # recreates only changed containers
deploy/scripts/wait-ready.sh
deploy/scripts/smoke.sh
```

VM install (`deploy/vm/install.sh`, systemd unit `ouo.service`, Caddy TLS): run the same
`git checkout`, `build` and `up -d` steps as the service user, or `systemctl restart ouo`
after the build, then verify through the public URL
(`curl -fsS https://<host>/healthz` on rum-api and a login to Grafana). Compare the
`.env` next to the compose file against `deploy/compose/.env.example` of the new release;
new variables have defaults, but a variable that was **renamed** is listed under
`Breaking` in the rum-api changelog and must be updated before `up -d`.

With the released images (`-f deploy/compose/compose.images.yaml`, ouo 0.2.0 and later) the
procedure shrinks to editing the `OUO_*_VERSION` tags in `.env`, `pull`, `up -d`. The
`ghcr.io/ziadmansourm/ouo/*` packages are private until ouo is stable, so the host needs a
`docker login ghcr.io` with a classic `read:packages` token first ("Pull access" in
`docs/releasing.md`).

## 3. Helm path

```bash
helm repo update                        # once the chart is published; for now use the checkout
git fetch --tags && git checkout chart-v<new>
helm diff upgrade ouo deploy/helm/ouo -n <namespace> -f my-values.yaml   # optional, helm-diff plugin
helm upgrade ouo deploy/helm/ouo -n <namespace> -f my-values.yaml \
  --set rumApi.image.tag=<rum-api version> \
  --set grafana.image.tag=<grafana image version> \
  --atomic --timeout 10m
kubectl -n <namespace> rollout status deploy/ouo-rum-api
kubectl -n <namespace> rollout status deploy/ouo-grafana
```

- `--atomic` rolls the release back automatically if a pod does not become ready; rum-api's
  readiness probe fails when it refuses to start (section 4), so a schema mismatch never
  leaves a half-upgraded release.
- Image tags default from `values.yaml` (`rumApi.image.tag`, `grafana.image.tag`); pin them
  in your values file so an `upgrade` with an unchanged chart does not move them.
- Bundled LGTM (`values.yaml` `lgtm.bundled`): Loki, Tempo and Mimir versions come from the
  chart; read their upstream upgrade notes when the chart bumps them. External LGTM
  (`values-external-lgtm.yaml`): nothing in this chart touches your stores.
- The Grafana image carries the plugin, so upgrading the plugin on Kubernetes is
  `--set grafana.image.tag=<new grafana image>`. Grafana's SQLite database lives on the
  Grafana PVC and is upgraded in place by Grafana itself; it is **not** downgradeable across
  Grafana major versions, so take the backup from section 1 before a Grafana major bump.

## 4. Replay chunk schema version

Replay chunks (`docs/specs/mobile-replay.md`) carry an integer `schema_version` (currently
`1`). rum-api stores chunks under `DATA_DIR/replays/<session_id>/<seq>.json.gz` and records
`kind` in `meta.json`.

Compatibility rule:

- A rum-api release knows a **maximum schema version**. It accepts chunks with any
  `schema_version <= max` it can read and rejects newer ones with `400` (today: anything but
  `1`, see `internal/replay/parse.go`).
- **Requirement (not yet implemented):** on start-up rum-api must scan the data directory
  (a `schema.json` marker at `DATA_DIR/replays/schema.json` written on every successful
  start with `{"max_schema_version": N, "rum_api_version": "x.y.z"}` avoids walking every
  session) and **refuse to start** when the directory was last written by a rum-api that
  knows a **newer** schema than itself. The exit message names both versions and points at
  this section. This is what makes a rollback safe: an old binary never half-reads new data.
- Upgrading never rewrites stored chunks. A newer rum-api reads older schemas forever (or
  until a documented minimum, announced one minor in advance).
- SDK side: an SDK that emits a new `schema_version` states the minimum rum-api version in
  its changelog; rum-api rejects chunks it cannot read, and the SDK drops them after the
  retry budget. Upgrade rum-api before the SDKs.

The qa agent verifies, once implemented: start the new rum-api on a copy of the previous
release's data directory (must start and serve old replays), then start the previous rum-api
on a data directory written by the new one with a bumped schema marker (must refuse with a
clear message and exit code 1).

## 5. Compatibility table

Minimum versions that work together. Update this table with every release that changes a
contract between components. Versions are those of Phase 8a; nothing is tagged yet.

| Component | Version | Needs rum-api | Needs Grafana | Notes |
|---|---|---|---|---|
| rum-api | 0.2.0 | n/a | 13.x for the plugin proxy; any for ingest | ADR-0007: project token on ingest, read token for the plugin; max replay `schema_version` 1 |
| `@ouo/browser` | 0.2.0 | >= 0.2.0 | n/a | posts OTLP to rum-api `/ingest/otlp` with `X-Ouo-Project-Token`; 0.1.x posted to the collector directly and does not work behind the gateway |
| `@ouo/react-native` | 0.2.0 | >= 0.2.0 | n/a | same gateway change; frames replay `schema_version` 1 |
| `OuoReplay` (iOS) | 0.2.0 | >= 0.2.0 | n/a | project token on `POST /v1/replay/chunks` |
| `ouo-rum-app` plugin | 0.3.0 | >= 0.2.0 | >= 13.0.0 (`grafanaDependency`) | read token in the plugin route; 0.2.x called rum-api unauthenticated and gets `401` from rum-api 0.2.0 |
| grafana image | 0.2.0 | n/a | ships Grafana 13.2.1 + plugin 0.3.0 | |
| Helm chart | 0.1.0 | `appVersion` 0.2.0 | | Kubernetes >= 1.25 |

Rule of thumb: same minor across rum-api, both SDKs and OuoReplay is always supported; an
SDK one minor **behind** rum-api is supported; an SDK **ahead** of rum-api is not.

## 6. Rollback

- **Compose:** `git checkout <previous tag>`, rebuild the plugin, `docker compose build
  rum-api backend`, `docker compose up -d`. Data directories are untouched by an upgrade, so
  rolling rum-api back works as long as the new release did not bump the replay schema
  (section 4 guard). Restore the Grafana volume from the backup if Grafana itself was
  downgraded across a major version.
- **Helm:** `helm rollback ouo <revision> -n <namespace>` (revision from `helm history`).
  With `--atomic` the failed upgrade already rolled back. PVCs are kept across rollbacks.
- **SDKs:** pin the previous version in the application's `package.json` / `Package.swift`
  and redeploy the app. Sessions started by the newer SDK remain readable.
- **Plugin (compose):** check out the previous `plugin-v*` tag, rebuild `dist/`, hard-reload
  the browser (Grafana caches `module.js?_cache=<version>`).
- Never roll back by deleting data. A rum-api that refuses to start on newer data is doing
  its job; move forward to the version that wrote the data instead.

## 7. After the upgrade

- `deploy/scripts/smoke.sh` (compose) or the chart's `NOTES.txt` checks (Helm): one trace,
  one log, one metric round trip plus a replay chunk upload with the project token.
- Open the plugin, check the Overview tiles fill for the last hour and that an older session
  with replay still plays.
- Record the upgrade (from, to, date, who, anything unexpected) in your operations log; the
  qa agent records rehearsals in `project/agents/qa/`.
