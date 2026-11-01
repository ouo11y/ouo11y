# Upgrading ouo

Operator procedure for moving an installation from one release to the next, for the Docker
Compose path (laptop and the VM install under `deploy/vm/`) and the Helm path. Versioning
and tag names are in `docs/releasing.md`; this document assumes the images and packages of
the target release already exist.

Status: rehearsed (section 8) on 2026-10-23 (a VM install of 0.2.0 from its released images
upgraded to 0.3.0 with replays of all three kinds, and `helm upgrade` from chart 0.1.0 to
0.1.1 on kind) and on 2026-11-01 (compose with the released images, from rum-api 0.5.0,
collector 0.4.0 and grafana 0.5.0 to the M2/M3 set, across the replay schema 2 bump). The
schema-version guard of section 4 ships in rum-api 0.4.0 and later.

## 1. Before any upgrade

1. Read the per-package changelogs for every version you are skipping over, especially the
   `Breaking` and `Compatibility` headings (`CHANGELOG.md` at the root links them all).
2. Check the compatibility matrix ([`../compatibility.md`](../compatibility.md)). Upgrade in this order when more than one
   component changes: **rum-api first, then the Grafana image (plugin), then the collector,
   then the SDKs**. On compose, one component per `up -d`, checking `/readyz` and the plugin
   in between; one `helm upgrade` moves the three images together (section 3), which is fine
   as long as the SDKs come after it. rum-api is backwards compatible with the previous SDK minor; SDKs are
   not forwards compatible with an older rum-api, and a newer collector can accept a replay
   schema an older rum-api refuses (section 4).
3. Back up what cannot be rebuilt: the rum-api data directory (replay chunks and
   `meta.json` files), the Grafana database (dashboards, service accounts, plugin settings),
   and the project registry file if you use `OUO_PROJECTS_FILE`. Loki, Tempo and Mimir data
   are telemetry; back them up according to your retention needs (Phase 8c drill). Compose:
   the commands in [`deploy/vm/README.md`](../../deploy/vm/README.md), "Backup" (volumes
   `ouo_<name>`, rum-api's bind mount `deploy/data/rum-api`). Under `ouo-env` the volumes are
   `ouo-<env>_<name>`, rum-api's data included (`ouo-<env>_rum-api-data`).
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
npm ci && npm run -w plugins/ouo11y-rum-app build   # plugin dist that Grafana mounts
docker compose -f deploy/compose/compose.yaml pull     # Grafana, Loki, Tempo, Mimir, collector tags
docker compose -f deploy/compose/compose.yaml build rum-api backend
docker compose -f deploy/compose/compose.yaml up -d    # recreates only changed containers
deploy/scripts/wait-ready.sh
deploy/scripts/smoke.sh
```

With the released images (`-f deploy/compose/compose.images.yaml`, ouo 0.3.0 and later: the
0.2.0 images exist only under the old `ghcr.io/ziadmansourm/ouo` path) the procedure shrinks
to editing the `OUO_*_VERSION` tags in `deploy/compose/.env`, one component at a time in the
order of section 1, and `up -d` after each (it pulls a tag that is not on the host yet and
recreates only the changed container):

```bash
export COMPOSE_FILE=deploy/compose/compose.yaml:deploy/compose/compose.images.yaml
sed -i.bak 's/^OUO_RUM_API_VERSION=.*/OUO_RUM_API_VERSION=<new>/' deploy/compose/.env
docker compose up -d && deploy/scripts/wait-ready.sh    # then OUO_GRAFANA_VERSION, then OUO_COLLECTOR_VERSION
deploy/scripts/smoke.sh
```

The images bring their own binaries but not their config files: `compose.yaml` mounts the
collector, rum-api, Loki, Tempo and Mimir configs from the checkout. When a release changes
anything under `deploy/compose/` other than the pins (`git diff <your commit> <release-train
commit> -- deploy/compose`), check out the release-train commit first (keeping your `.env`,
which is gitignored), then edit the pins. The
`ghcr.io/ouo11y/*` images are public, so the host needs no `docker login` ("Pull access" in
`docs/releasing.md`). `compose.images.yaml` copies the plugin out of the new Grafana image
onto the `grafana-data` volume before Grafana starts (service `grafana-plugin`); without that
step the volume keeps the plugin of the first install forever, and 0.2.0 -> 0.3.0 (plugin id
`ouo-rum-app` -> `ouo11y-rum-app`) fails with `plugin not installed: "ouo11y-rum-app"`.

### VM install (`deploy/vm/install.sh`)

Re-run the installer with the target ref; it keeps `.env`, the project registry and the data,
switches the checkout, pulls or builds, re-applies `up -d` and rewrites `ouo.service` for the
same compose files. Run it as root (`sudo`): the checkout belongs to root, so plain `git` in
`/opt/ouo` stops with `detected dubious ownership`.

```bash
sudo /opt/ouo/deploy/vm/install.sh --images --ref <tag or main>    # released images
sudo /opt/ouo/deploy/vm/install.sh --ref <tag or main>             # build from source
```

From 0.2.0 (one time): the installer of 0.2.0 does not know the `deploy/docker/` ->
`deploy/compose/` move (ADR-0010) and stops with `open deploy/docker/compose.yaml: no such
file or directory` after it has checked out the new release (the running stack is untouched).
Run the new installer instead; it moves `.env` and `projects.htpasswd` to `deploy/compose/`
and keeps every token:

```bash
sudo git -C /opt/ouo fetch --tags origin
sudo git -C /opt/ouo show origin/main:deploy/vm/install.sh > /tmp/install.sh
sudo bash /tmp/install.sh --images --ref main
```

From then on the checked-out installer hands over to the one of the release it installs, so
`sudo /opt/ouo/deploy/vm/install.sh --ref <tag>` is enough. Verify through the public URL
afterwards (`deploy/vm/README.md`, "Operate": `smoke.sh` against `https://<otel host>`), log in
to Grafana and open an older replay.

Compare the `.env` next to the compose file against `deploy/compose/.env.example` of the new
release; new variables have defaults, but a variable that was **renamed** is listed under
`Breaking` in the rum-api changelog and must be updated before `up -d`.

## 3. Helm path

The chart is published from 0.2.0 on as `oci://ghcr.io/ouo11y/charts/ouo` (private: `helm
registry login` first, "Pull access" in `docs/releasing.md`); a checkout of the chart tag
works the same with no login (use `deploy/helm/ouo` and drop `--version` below). The package
leaves out the example values files (`values-kind.yaml`, `values-external-lgtm.yaml`,
`values-ha-example.yaml`, excluded by `.helmignore`): take them from the tag.

```bash
helm diff upgrade ouo oci://ghcr.io/ouo11y/charts/ouo --version <new chart> -n <namespace> -f my-values.yaml   # optional, helm-diff plugin
helm upgrade ouo oci://ghcr.io/ouo11y/charts/ouo --version <new chart> -n <namespace> -f my-values.yaml \
  --set rumApi.image.tag=<rum-api version> \
  --set grafana.image.tag=<grafana image version> \
  --set collector.image.tag=<collector version> \
  --rollback-on-failure --timeout 10m     # Helm 4; Helm 3: --atomic
kubectl -n <namespace> rollout status deploy/ouo-rum-api
kubectl -n <namespace> rollout status deploy/ouo-grafana
kubectl -n <namespace> rollout status deploy/ouo-collector
```

- `--rollback-on-failure` (Helm 4; `--atomic` in Helm 3, deprecated in 4) rolls the release
  back automatically if a pod does not become ready. rum-api exits when it refuses a store
  (section 4), so a schema mismatch never leaves a half-upgraded release: rehearsed on kind,
  the guarded rum-api exited on a store marked with schema 2 and Helm rolled back to the
  previous revision.
- Image tags default from `values.yaml` (`rumApi.image.tag`, `grafana.image.tag`,
  `collector.image.tag`); pin them
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
`2` for `kind: "frames"`, ADR-0014, and `1` for `kind: "video"`). rum-api stores chunks under `DATA_DIR/replays/<session_id>/<seq>.json.gz` and records
`kind` in `meta.json`.

Compatibility rule:

- A rum-api release knows a **maximum schema version**. It accepts chunks with any
  `schema_version <= max` it can read and rejects newer ones with `400` (the maximum is
  `SchemaVersion` in `internal/replay/schema.go`, `parse.go` enforces it; video chunks stay at
  `1`). rum-api 0.6 is the first to read schema 2 and writes `2` into the marker below, so an
  older rum-api refuses to start on a store it has opened.
- **Start-up guard** (rum-api after 0.3.0, `internal/replay/schema.go`): every start reads the
  marker `replays/schema.json` (filesystem: `DATA_DIR/replays/schema.json`; S3:
  `[<prefix>/]replays/schema.json` in the bucket), `{"max_schema_version": N,
  "rum_api_version": "x.y.z", "updated_at": ...}`, and **refuses to start** (exit 1, before
  serving) when `N` is newer than the schema it reads itself:

  ```
  rum-api exited error="replay store written by a newer replay schema: the store was last opened by
  rum-api 0.9.0, which reads replay schema_version up to 2; this rum-api 0.4.0 reads up to 1. Run
  rum-api 0.9.0 or newer on this store; do not roll back across a schema bump (docs/operations/upgrade.md section 4)"
  ```

  Otherwise it records itself in the marker (only when the version changed). A store without a
  marker (written by 0.3.0 or older, which all read schema 1) is adopted. A marker that is not
  valid JSON or has `max_schema_version < 1` stops the start too (read error), so a damaged
  marker is never silently overwritten. A rollback on the **same** schema is allowed. This is
  what makes a rollback safe: an old binary never half-reads new data. Rum-api releases up to
  0.3.0 have no guard, so the protection starts with the release after 0.3.0.
- Upgrading never rewrites stored chunks. A newer rum-api reads older schemas forever (or
  until a documented minimum, announced one minor in advance).
- SDK side: an SDK that emits a new `schema_version` states the minimum rum-api version in
  its changelog; rum-api rejects chunks it cannot read, and the SDK drops them after the
  retry budget. Upgrade rum-api before the SDKs. For schema 2 the order is rum-api and the
  plugin 0.10 (a plugin built for schema 1 shows patch frames as broken images; most deployments get
  the plugin through the grafana image, so that means the grafana image that ships it), then the collector
  (its replay receiver rejects schema 2 below collector 0.5), then the SDKs.

Verified 2026-10-23 (section 8): the guarded rum-api started on the 0.2.0-written VM store and
served every old replay unchanged; with the marker bumped to schema 2 it exited 1 with the
message above, in compose (restart loop, `/readyz` unreachable) and on kind (Helm rolled back),
and on S3 (MinIO) it wrote the marker into the bucket. Unit tests: `schema_test.go` (filesystem
and S3).

## 5. Compatibility table

Moved to [`../compatibility.md`](../compatibility.md): one line per release line of every
component with the minimum collector, rum-api, plugin and Grafana versions it needs, and the
replay `schema_version` each side reads or emits. A release PR fails its `release-check` until
that file covers the new version.

Rule of thumb: upgrade the collector and rum-api before the SDKs; an SDK one minor **behind**
the collector is supported, an SDK **ahead** of it is not.

## 6. Rollback

- **Compose:** `git checkout <previous tag>`, rebuild the plugin, `docker compose build
  rum-api backend`, `docker compose up -d`. Data directories are untouched by an upgrade, so
  rolling rum-api back works as long as the new release did not bump the replay schema
  (section 4 guard). Restore the Grafana volume from the backup if Grafana itself was
  downgraded across a major version. With the released images: put the previous
  `OUO_*_VERSION` back in `.env` and `up -d`. Not rum-api once 0.6.0 has run: rum-api 0.5.0
  then exits 1 with the section 4 message and the store is left as it was (rehearsed
  2026-11-01). The Grafana image and the collector are not guarded, but once schema 2 data
  exists a plugin older than 0.10 shows its patch frames as broken images and a collector
  older than 0.5 rejects schema 2 chunks: fix forward instead (not rehearsed).
- **Helm:** `helm rollback ouo <revision> -n <namespace>` (revision from `helm history`).
  With `--atomic` the failed upgrade already rolled back. PVCs are kept across rollbacks.
  Not across a replay schema bump: once rum-api 0.6.0 (chart 0.2.0) has run, never roll back
  to chart 0.1.x, by hand or through `--rollback-on-failure` / `--atomic`. Its rum-api 0.3.0 has
  no schema guard (section 4) and must not run on a store that holds schema 2 chunks; fix a
  failed upgrade forward.
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

## 8. Rehearsals

| Date | Path | From -> to | Data | Result |
|---|---|---|---|---|
| 2026-10-23 | VM (Ubuntu 24.04 under Lima), `install.sh` | 0.2.0 images -> 0.3.0 images (installer from this branch) -> build from source | 3 rrweb, 1 frames, 3 Sentry video replays (79 envelopes), 80 sessions with traces | every replay byte-identical through rum-api (sha256 of events, frames, each mp4 segment), sessions, status, trace counts and health buckets identical; findings in `deploy/vm/README.md` |
| 2026-10-23 | Helm on kind | chart 0.1.0 (0.2.0 images) -> 0.1.1 (0.3.0 images) | 4 rrweb, 1 frames replays, 81 sessions | identical as above; plugin re-installed by the init container (0.7.0) |
| 2026-11-01 | compose with `compose.images.yaml` under `ouo-env`, the checkout of 2026-10-27 (`48fc296`) kept, pins edited one at a time | rum-api 0.5.0, grafana 0.5.0 (plugin 0.9.0), collector 0.4.0 -> rum-api 0.6.0, grafana 0.6.0 (plugin 0.10.0), collector 0.5.0 | 4 rrweb (one a real `@ouo11y/browser` 0.3.0 session from npm), 1 frames, 3 Sentry video replays, 42 sessions | 8 replays byte-identical through rum-api and through the plugin proxy, 42 sessions and the health buckets identical; store marker 1 -> 2, rum-api 0.5.0 then refuses it; smoke, e2e, the ouo-web journey with `@ouo11y/browser` 0.3.1 from npm (28/28, replay) and the React Native conformance suite on the npm 0.3.0 bundle (schema 2 chunks next to schema 1) pass; `helm template` of the published chart 0.2.0 names the same images |

Method and evidence: `project/agents/platform-infra/reports/2026-10-23-8a-vm-upgrade-n12.html`
and `project/agents/release/reports/2026-11-01-qa-upgrade-m2-m3.html`; the seed and
fingerprint script is `project/agents/platform-infra/tools/upgrade-replays.py`.
