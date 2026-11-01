# 2026-11-01: QA run of the upgrade procedure for the M2/M3 release set

The M2/M3 release trains row in the root `CHANGELOG.md` said no stack had run the released
images and the upgrade procedure had not been run. This session ran it with `ouo-env`.

Result: **the upgrade works.** Old replays and sessions read back byte-identical, the new
SDKs from npm send sessions with replay, and rum-api 0.5.0 refuses the store afterwards as
documented. Two small product findings (N90, N91) and a set of gaps in
`docs/operations/upgrade.md`, fixed in this PR.

## From and to

| | rum-api | collector | grafana image (plugin) | browser SDK | react-native SDK |
|---|---|---|---|---|---|
| Previous set (manifest at `42a2e07`, pins from `48fc296`, 2026-10-27) | 0.5.0 | 0.4.0 | 0.5.0 (0.9.0) | 0.3.0 | 0.2.1 |
| M2/M3 set (release-train commit `6893447`, `browser-v0.3.1`) | 0.6.0 | 0.5.0 | 0.6.0 (0.10.0) | 0.3.1 | 0.3.0 |

Chart: 0.1.1 was never published (no `chart-v0.1.1` tag), so there is no Helm "from"; the
published 0.2.0 was rendered only (below).

## Steps, in order

1. Detached worktree at `48fc296` (the last `main` commit before #128 whose `deploy/compose/`
   is the previous set's: `.env.example` pins 0.5.0 / 0.4.0 / 0.5.0; no config under
   `deploy/compose/` differs from `main` except pins and the source-build Grafana base);
   `.env.example` copied to `.env`. `ouo-env up qa-upgrade --images --src <it> --branch
   claude/qa-upgrade-m3`: images 0.5.0 / 0.4.0 / 0.5.0, plugin 0.9.0, store marker
   `max_schema_version: 1` by rum-api 0.5.0.
2. Data on the old stack: `smoke.sh` and `e2e.sh` of the old checkout (E2E OK, 40 sessions);
   `upgrade-replays.py seed` (2 rrweb, 2 frames schema 1 chunks, the 79 envelopes of the Sentry
   8.30.0 `shop` golden journey: 3 video replays); the ouo-web journey with
   **`@ouo11y/browser` 0.3.0 installed from npmjs.org** in a copy of the example outside the
   workspace (28/28 checks of `verify.py`, rrweb replay, symbolicated render error).
3. Fingerprint before: `upgrade-replays.py check` (8 replays, 42 sessions, health buckets, fixed
   window 12:40 to 13:10 UTC) and the same replays through Grafana's plugin proxy.
4. Procedure, section 1: changelogs read (rum-api **Breaking**: schema 2; Compatibility notes of
   collector, grafana, plugin); `.env` compared with `main`'s `.env.example` (only the pins
   differ); backups of the `rum-api-data` and `grafana-data` volumes (tar through `alpine`);
   running versions recorded (`docker compose -p ouo-qa-upgrade images`).
5. Section 2, images path, one pin at a time in the order rum-api, grafana, collector, each
   followed by the same `ouo-env up` (= `compose up -d`):
   - rum-api 0.6.0: only rum-api recreated; marker now `max_schema_version: 2`, rum-api 0.6.0;
     the fingerprint diff against step 3 is empty (rum-api 0.6.0 with collector 0.4.0 and plugin
     0.9.0).
   - Rollback guard: `docker compose ... run --rm --no-deps rum-api` with
     `OUO_RUM_API_VERSION=0.5.0`: exit 1, `replay store written by a newer replay schema ... this
     rum-api 0.5.0 reads up to 1`, marker unchanged. The ADR-0014 risk behaves as documented.
   - grafana 0.6.0: `grafana-plugin` then grafana recreated, `ouo11y-rum-app 0.10.0 installed`;
     plugin-proxy reads identical, only the plugin version changed.
   - collector 0.5.0: recreated, `Everything is ready`, no errors.
6. Verification:
   - `smoke.sh` (SMOKE OK) and `e2e.sh` of `main` (E2E OK, 40 sessions).
   - `upgrade-replays.py diff`: 8 replays (3 video, 4 rrweb, 1 frames) and 42 sessions
     identical; one entry differs, `smoke-session`, because the post-upgrade smoke run reuses
     that fixed id inside the window (not a regression).
   - Plugin proxy: every replay payload (events, frames, the first video segment) identical,
     plugin 0.10.0.
   - **`@ouo11y/browser` 0.3.1 from npmjs.org** (lockfile `resolved` to the registry tarball):
     ouo-web journey 28/28, session `9e2b095c…` with `ouo_sdk_version` 0.3.1 in Loki and an rrweb
     replay. Seen in Grafana: the new and the old (0.3.0) session pages both render their replay
     in plugin 0.10.0.
   - **`@ouo11y/react-native` 0.3.0 from npmjs.org**: its `dist/` under the conformance stand-in
     (`tests/e2e/mobile/conformance.mjs`): CONFORMANCE OK, 18 required checks; the store now holds
     frames schema 2 chunks next to the schema 1 ones.
   - Chart: `helm pull oci://ghcr.io/ouo11y/charts/ouo --version 0.2.0` (digest
     `sha256:71e2e37a…`, same as the checkpoint), `helm template` with the required values:
     `rum-api:0.6.0`, `collector:0.5.0`, `grafana:0.6.0` (twice: init container and Grafana);
     also renders with the tag's `values-external-lgtm.yaml` and `values-ha-example.yaml`;
     `helm lint` clean. The package equals the tag's chart; the three example values files are
     left out by `.helmignore`.

## Deviations from the documented procedure

- The env ran under `ouo-env` (named volumes, project `ouo-qa-upgrade`) instead of plain
  `docker compose`: same compose files and `up -d`, but rum-api's data is a volume, not
  `deploy/data/rum-api`.
- "pull" was implicit: `pull_policy: missing` pulls the new tag on `up -d`.
- The checkout was kept at `48fc296` (the doc's images path says to edit `.env` only); this was
  correct here only because nothing under `deploy/compose/` changed between the two sets.

## Problems in the procedure, fixed in `docs/operations/upgrade.md`

- Section 1's order named rum-api, Grafana, SDKs and left out the collector; section 4 and
  every changelog's Compatibility note say rum-api and the plugin, then the collector, then
  the SDKs. Now one order, one component per `up -d`.
- Section 1 said to back up rum-api's data and Grafana's database but not where they are on
  compose; now a pointer to `deploy/vm/README.md` "Backup" and the `ouo-env` volume names.
- Section 2 said "ouo 0.2.0 and later" for the images path (0.2.0 images exist only under the
  old registry path), and did not say that the images do not carry their config files: a
  release that changes `deploy/compose/` needs the release-train commit checked out. The root
  `CHANGELOG.md` row it points to named no commit; it now names `6893447`.
- Section 3 still said the chart was not published, and left the collector tag out of the
  `--set` list; now the OCI path, the login, the missing example values files and all three
  tags.
- Section 6 had no rollback for the images path; now that rum-api cannot go back once 0.6.0 ran
  (verified) and why the Grafana image and collector should not either (not rehearsed).
- The status line still called the guard unreleased; section 8 gets this rehearsal.

## Product findings (checklist)

N88 and N89 are claimed by the open PR #145, so these are N90 and N91.

- N90: `compose.images.yaml`'s `grafana-plugin` reruns on every `up -d` and replaces the
  plugin folder under a running Grafana (seen at the rum-api step).
- N91: `examples/ouo-web` needs the workspace's `@types/node` to build.

Not new: `@ouo11y/browser` 0.3.0 stamps `ouo.sdk.version` 0.2.0 (fixed in 0.3.1, #130). The
Sentry golden journey's sessions never reach Loki any more (2026-10-14 timestamps, Loki's 168 h
old-sample limit), so their session pages are 404 before and after the upgrade; their replays
read fine (kb `upgrade-rehearsal.md`).

## Not done

- No Helm upgrade on a cluster (only `helm template` was asked for, and no published 0.1.x
  exists to upgrade from); no VM `install.sh` run; no real device or simulator for React Native
  (the stand-in models the native module).
- A Grafana image rollback (0.6.0 -> 0.5.0, same Grafana major) was not tried.

## Next session

Evidence: [the report](../reports/2026-11-01-qa-upgrade-m2-m3.html) (steps, before / after
fingerprints); the raw logs and backups stayed in this session's scratchpad. The qa-upgrade env
was taken down with its volumes kept (`ouo-env down qa-upgrade`); `ouo-env gc` removes it once
this branch is merged. The detached worktree `.claude/worktrees/qa-upgrade-m3-prev` was removed.

## Review

Reviewer session (PR #147, `Review: changes needed`): wrong volume name in the first backup
command (`compose.yaml` sets `name: ouo`), `$F` / `$V` word splitting fails in zsh, section 1's
one-component rule against the one `helm upgrade`, `.helmignore` is in the package, an
unrehearsed rollback claim, the collector rollout check. All fixed; the evidence moved from the
scratchpad into an HTML report.
