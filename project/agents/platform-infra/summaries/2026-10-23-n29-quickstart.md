# 2026-10-23: N29 single-file quickstart compose

## What was done

- `deploy/compose/quickstart.yaml`: the whole local stack in one compose file (released ouo
  images, upstream Loki / Tempo / Mimir, every mounted config inlined as `configs.content`,
  no demo backend, project `ouo-quickstart`). Copy into an empty folder and `docker compose up -d`.
- `deploy/scripts/gen-quickstart.sh`: generates it from `compose.yaml`, `compose.images.yaml`
  and the config files; `--check` exits 1 when the committed file is stale.
- CI job `quickstart` in `.github/workflows/ci.yml` (path flag `quickstart`:
  `deploy/compose/` or the script): `--check` and `docker compose config --quiet`.
- Docs: `examples/fast-tracked/00-stack.md` Step 1 "One file, no clone", `deploy/README.md`,
  root `README.md` Quickstart, `docs/releasing.md` step 9 (regenerate after a pin bump).
- `project/kb/compose-quickstart.md`, checklist N29.

## How it was verified

From an empty scratch folder with only the file (as `compose.yaml`) and a `.env` shifting every
host port (so it ran next to the founder's stacks without touching them):

- `docker compose up -d`: all services running, grafana and rum-api healthy, `grafana-plugin` exited 0.
- The 8 inlined configs are byte-identical to the repo files inside the containers (`diff` via
  `docker compose exec` / `cp`), including the `$${...}` escapes in `datasources.yaml`.
- `OUO_ENV_FILE=<.env> deploy/scripts/wait-ready.sh` and `smoke.sh`: SMOKE OK (trace, log,
  metric, replay chunk read back from rum-api with the read token, CORS and 401 negatives).
- Grafana: plugin enabled, `secureJsonFields.readToken: true`, plugin proxy to rum-api 200,
  Loki / Tempo / Mimir datasources provisioned.
- `--check` exits 1 after a one-line change to `loki/config.yaml` and 0 after reverting.
- Then `docker compose down -v`; nothing left running.

This run used raw `docker compose` on a scratch project instead of `ouo-env` on purpose: the
thing under test is the standalone file a user copies, outside the repo.

## Left / next agent must know

- The images are still private, so the quickstart still needs `docker login ghcr.io`.
  Once they are public it is truly copy-and-run.
- rum-api's volume is mounted on `/home/nonroot` with `DATA_DIR=/home/nonroot` because the image
  runs as nonroot (kb entry). The contributor `compose.yaml` bind-mounts `../data/rum-api`
  instead; on a Linux host that directory is created root-owned, which this run did not look into.
- No new dependency.
