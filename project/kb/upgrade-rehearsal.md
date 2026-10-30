# Upgrade rehearsal with existing replays

Status: filled by platform-infra on 2026-10-23 (roadmap 8a "Upgrade procedure tested").

## Question

How do we prove an ouo upgrade keeps old replays playable and sessions, health and traces
intact, on the VM install and on Helm?

## Method that worked

1. Install the old release from its images (VM: the 0.2.0 installer with `compose.images.yaml`
   added; kind: chart 0.1.0 from `git archive rum-api-v0.2.0 deploy/helm/ouo`).
2. Seed through the collector, as the SDKs do:
   `project/agents/platform-infra/tools/upgrade-replays.py seed` posts two rrweb and two frames
   chunks and replays every captured Sentry envelope of
   `collector/receiver/ouosentryreceiver/testdata/golden/ios-rn-8.30.0/shop` (79 envelopes, 3
   video replays) to the bridge; `deploy/scripts/e2e.sh` **of the old tag** adds the 40-session
   matrix (HEAD's scenario checks fields the old rum-api does not have).
3. `upgrade-replays.py check --from <t0> --to <t1>` with a fixed window records a sha256 per
   replay payload (events, frames, each mp4 segment), the health buckets and every session's
   status, trace count and timeline length. Run it before and after, then `diff`.
4. Upgrade with the documented procedure only.

## Gotchas

- kind on Docker Desktop's containerd image store: `kind load docker-image` of a multi-arch
  image fails with `ctr: content digest ... not found`. Use
  `docker save --platform linux/arm64 <img> | docker exec -i <node> ctr -n k8s.io images import --snapshotter=overlayfs -`.
- Helm 4 deprecates `--atomic`; `--rollback-on-failure` rolled the release back when the
  guarded rum-api refused a bumped store (`replays/schema.json` written from a busybox pod as
  uid 65532 on the PVC).
- `--reuse-values` keeps the old release's values, image tags included; upgrade with `-f`.
- The Sentry golden envelopes carry 2026-10-14 timestamps; replays from them play by id, but
  the sessions fall outside a "last hours" window.
- The old e2e scenario fails `has_error <trace id>` when the failed trace id starts with `0`:
  Tempo strips leading zeros and the scenario normalises ids for the list check but not for
  that lookup (1 in 16 runs). The data is right. Fixed by #119: both comparisons use
  `normTraceId`.
- `helm --wait` on a release with `rumApi.replicas: 0` and a PVC never finishes (the claim is
  `WaitForFirstConsumer` and stays Pending).
- Empty OTLP requests bypass `ouoratelimit` (N13): a rate-limit test must send a span.
- Docker Desktop memory: self-hosted Sentry (about 14 GB) next to kind starved the API server
  (`TLS handshake timeout`) and Grafana's probes; check `docker stats` before each install.
