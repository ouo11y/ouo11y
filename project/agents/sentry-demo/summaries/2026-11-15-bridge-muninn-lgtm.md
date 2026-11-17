# 2026-11-15 Sentry bridge, Muninn and LGTM in one collector

Question: with the Sentry bridge (`ouosentry`, :4320) in front of an unchanged Sentry SDK, does ouo-collector feed Muninn, Loki, Tempo and Mimir together, in one config, without the SDK ever waiting on a backend? Report: [bridge-muninn-lgtm.html](../reports/bridge-muninn-lgtm.html).

## Done

- **Found**: the `--muninn` stack's collector (`config.muninn.yaml`) had no bridge (port 4320 published and advertised, nothing listening). Bridged replay is the MVP `kind: "video"` JSON chunk, which Muninn's wire refuses and ADR-0019 forbids translating in the collector.
- **`deploy/compose/collector/config.muninn-sentry.yaml`**, merged over `config.muninn.yaml` by a second `--config` in `compose.muninn.yaml`: bridge errors, sessions, logs, vitals and breadcrumbs to Loki, transactions to Tempo (span metrics to Mimir), bridged video to rum-api; spec-wire replay to Muninn unchanged. Transitional: delete it when the bridge emits `ouo-video/1` or when PR #208 lands.
- **`examples/tools/sentryreplay.py`** (+ `test_sentryreplay.py`, 6 tests in the CI `unittest discover`): replays a sentrytap capture in real time with timestamps moved to now and fresh ids, rewrites msgpack replay items, saves what it sent as a capture; `--passes/--concurrency/--gap 0` for load.
- **`deploy/scripts/sentry-demo.sh`**: replay, `verify-bridge.py`, Mimir checks, optional `tests/e2e/muninn` and load. **`deploy/scripts/sentry-backpressure.sh`** + **`tests/e2e/muninn/load.mjs`**: baseline, Loki, Muninn, rum-api down.
- **`verify-bridge.py`**: errors follow bridge spec section 6 (an info `captureMessage` is a `sentry.message`); `--no-backend` for replayed captures.
- **Loki gRPC server message size** (`server.grpc_server_max_{recv,send}_msg_size` in `deploy/compose/loki/config.yaml` and the Helm Loki configmap): 4 MiB to 64 MiB; the querier's client side already allows 100 MiB. With a few thousand bridged sessions, a 5 000-line split was 5.3 MB and rum-api's session list hung 60 s.

## Verified, and how

- Env `priceless-sutherland-7e7eb0` (`--muninn`): demo 58/58: verify-bridge 30/30 (4 sessions with status and end reason, 3 errors + 1 crash, 15 logs, 20 console lines, 28 network breadcrumbs, 19 traces with session.id, 20/20 replay segments sha256-equal and decoded by AVFoundation), Mimir 3/3 (`traces_spanmetrics_calls_total{service="sentry-demo"}` 96, bridge counters), `tests/e2e/muninn/run.mjs` 25/25 against the same collector. Rerun from the final paths: 30/30 + Mimir.
- Plugin (built-in browser, page text): Sessions page lists the bridged sessions with status, crashes, errors, traces and video replay; the session page shows device, vitals (cold start 3.43 s, TTID), 92 timeline events and the Sentry replay player.
- Back-pressure, two runs (default limits; limits at 100 000): the bridge answered 600/600 envelopes 200 in every phase, p99 under 200 ms; collector memory under 100 MiB; after restart 40/40 sessions in Loki, 200/200 chunks in Muninn (54 MB disk queue, drained in 15 s), 40/40 replays in rum-api.
- `python3 -I -m unittest discover -s examples/tools` 14/14; `helm lint` and `helm template -f values-kind.yaml` render the Loki change; lychee offline (see PR).

## For the next agent

- **Before the cutover**: the bridge passes no request metadata to the pipeline, so `ouoratelimit` keys bridged output on the TCP peer. Behind Caddy, every phone shares one 100/s client bucket and ouo silently loses most bridged data (Sentry does not). Fix in the receiver (`X-Forwarded-For` into `client.Info.Metadata`) or raise the client bucket. Measured: 14 to 23 of 40 sessions reached Loki from one address.
- **PR #208** sends bridged replay to `debug` and deletes `compose.muninn.yaml`; after it, drop `config.muninn-sentry.yaml`. Bridged replay is then stored nowhere until the receiver emits `ouo-video/1` (plan in the report, about one session, receiver code).
- `ouo-env up` failed while the shared Traefik's 3 s health check timed out (a self-hosted Sentry loaded the Mac); the stack was started with the compose command ouo-env generated (same project, env file and ports).
- Outages tested lasted 1 to 2 minutes; Loki, Tempo and rum-api queues are in memory (5 min of retries).

## Env left running

`priceless-sutherland-7e7eb0`, Grafana http://grafana.priceless-sutherland-7e7eb0.ouo.localhost (admin / testing567), Sentry DSN host `localhost:20592`, OTLP `localhost:20590`. Tear down with `deploy/envs/ouo-env down priceless-sutherland-7e7eb0` once the PR is merged.

## Dependencies

None added (Python standard library; `load.mjs` uses `tests/e2e/muninn`'s existing helpers).
