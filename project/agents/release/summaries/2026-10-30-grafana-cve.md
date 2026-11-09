# 2026-10-30: grafana base image 13.2.5 for a CRITICAL CVE

## Why

`image (grafana)` failed its "Trivy (fail on fixable CRITICAL)" step on PRs #106 and #107,
neither of which touched the image: a new advisory hit the base `grafana/grafana:13.2.1`. The
gating table (the second Trivy run in the job log, run 40949298046) held exactly one finding:
`brotli-libs` 1.2.0-r1, CVE-2026-111497 (CRITICAL, out-of-bounds write in the Brotli decoder),
fixed in 1.2.1-r0. The Grafana Go binaries had no fixable CRITICAL, only HIGHs (informational).

## What changed

- `deploy/images/grafana/Dockerfile`: `FROM grafana/grafana:13.2.5` (newest 13.2 patch,
  2026-10-27, Alpine 3.24.3).
- `deploy/compose/compose.yaml`: the same Grafana for the local stack and `ouo-env`, so the
  bind-mounted plugin runs on the version the image ships.
- `examples/fast-tracked/00-stack.md`: the pinned-images line.
- `deploy/images/grafana/CHANGELOG.md`: `Unreleased` note naming the new base.
- `project/kb-archive/release-automation.md`: how to read a red Trivy gate caused by the base.
- `docs/compatibility.md`: this `fix` touching `deploy/images/grafana` cuts grafana 0.5.1, which
  stays on the one-per-line `grafana | 0.5` row, so that row now says 13.2.5 from 0.5.1 (0.5.0:
  13.2.1). The 0.4 row stays at 13.2.1.
- `project/kb-archive/collector-lgtm.md`: the pinned-tags table.

The Trivy step is unchanged.

13.2.4 still has `brotli-libs` 1.2.0-r1 (Alpine 3.24.2); 13.3.0 has the fix too, but it is a
minor upgrade and not needed for this.

## Verified

- `apk list -I` inside the images: 13.2.1 and 13.2.4 `brotli-libs-1.2.0-r1`, 13.2.5 and 13.3.0
  `brotli-libs-1.2.1-r0`.
- Built `deploy/images/grafana/Dockerfile` for linux/amd64 with the plugin from
  `npm run build -w plugins/ouo11y-rum-app`; the job's smoke command passes; the job's gating
  Trivy command (`aquasec/trivy:0.76.1` by digest, `--severity CRITICAL --ignore-unfixed
  --exit-code 1`) exits 0 with 0 findings in every target. HIGH + CRITICAL: 35 fixable HIGH, 0
  CRITICAL.
- Ran the image: `/api/health` reports 13.2.5, the plugin registers (unsigned, allowed),
  `module.js` is served (200), enabling it through `/api/plugins/ouo11y-rum-app/settings` works
  and `/a/ouo11y-rum-app` returns 200. The container was removed afterwards.
- CI on the PR: `image (grafana)`, and through the `compose.yaml` change the quickstart and
  example jobs, which run the full stack on 13.2.5.

## Review

`Review: approve` from session review-pr-108-grafana-ba (env `review-pr-108` from 079ad4d:
smoke.sh, plugin pages, proxy calls). Its two doc fixes (compatibility row, kb table) and the
CHANGELOG wording nit are in the second commit.

## Left / next

- PRs #106 and #107 rebase on `main` after this merges.
- No env was started; nothing is left running.
