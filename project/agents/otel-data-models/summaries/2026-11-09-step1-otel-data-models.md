# Step 1: OpenTelemetry data models (2026-11-09)

## What was done

Read the primary sources at pinned versions (listed in [otel-common-model.md](../../../kb/otel-common-model.md)) and wrote seven kb entries, an HTML explainer and two small scripts. No product code changed. `project/kb-archive/` was not used.

## Findings the next agent must know

1. **Loki 3.7.9's native OTLP endpoint drops `event_name`**. Source has no reference to it, and a live test confirmed it.
2. **Loki turns a bytes body into a base64 string** and rejects bodies over 256 KB by default. Important for replay.
3. **OTEP 4430 is only partly done.** Spec v1.62.0 does not mark `AddEvent` Deprecated. Semconv already recommends exceptions as logs.
4. **Servers differ from the OTLP response rules.** Loki answers `204`, and answers `400` to a batch even though its good records were stored. Collector answers `400` for too-large, where the spec says `413`.
5. **Device clocks lose data, silently.** Loki rejects timestamps over 10 minutes ahead with a do-not-retry `400`.
6. **Spans are exported only at end, and OTLP has no partial span.** Open spans die with the tab, and their children become orphans.
7. **Short-lived clients do not fit the single-writer metrics model.** Delta does not fix the identity problem, and Mimir rejects delta by default.
8. **Batching dominates wire cost.** An event costs 444 gzipped bytes alone and 56 in a batch of 50. Event versus span differs by about 13 bytes.
9. **Default promotion lists are traps.** Loki indexes `service.instance.id`; VictoriaLogs makes all resource attributes stream fields; VictoriaMetrics promotes all to labels.
10. Browser conventions (`browser.*`, `session.*`, events) are all Development.

## What was verified and how

| Check | Method |
|---|---|
| Field shapes, numbers, comments | Read the `.proto` files at v1.11.1 |
| Spec rules and stability | Read the spec at v1.62.0 |
| Backend defaults and mapping | Read source and bundled docs at the tagged versions |
| Protobuf bodies from `wire_size.py` decode | POSTed to otelcol-contrib 0.165.0: `200` for all signals, debug exporter showed expected fields, including `EventName` and Delta temporality |
| Collector limit | 19 MiB accepted; 21 MiB and a 21 KB gzip that inflates to 21 MiB both got `400` |
| Loki mapping and limits | `backend_checks.py` against `grafana/loki:3.7.9` with its default local config, reading records back with categorized labels |
| Fetch keepalive 64 KiB, W3C flags | Read the current WHATWG and W3C documents |

**Not run:** Tempo, Mimir, VictoriaLogs, VictoriaTraces and VictoriaMetrics claims are from source and docs only. Storage cost per signal was not benchmarked. Wire sizes use synthetic data.

## How to repeat

```bash
docker network create ouo-step1-net
docker run -d --rm --name ouo-step1-otelcol --network ouo-step1-net -p 127.0.0.1:34318:4318 -v "$PWD/otelcol.yaml:/etc/otelcol-contrib/config.yaml:ro" otel/opentelemetry-collector-contrib:0.165.0
docker run -d --rm --name ouo-step1-loki --network ouo-step1-net -p 127.0.0.1:33100:3100 grafana/loki:3.7.9 -config.file=/etc/loki/local-config.yaml
python3 -I project/agents/otel-data-models/scripts/wire_size.py /tmp/otlp-pb
python3 -I project/agents/otel-data-models/scripts/backend_checks.py /tmp/otlp-pb
```

`otelcol.yaml` is an OTLP HTTP receiver on `0.0.0.0:4318` with a `debug` exporter at `verbosity: detailed`, for all three signals.

## What is left

- Founder walk-through.
- Step 2 starts from [otel-step2-questions.md](../../../kb/otel-step2-questions.md), only after founder approval.
- Worth testing later: Tempo and Mimir behaviour at their limits, and a Collector-to-Loki path that keeps `event_name`.

## Dependencies added

None. The scripts use only the Python standard library.

## Notes on this run

- The brief asked for a new worktree. The session's write hook only allows its own worktree, so this session's worktree was switched to the base branch, and the temporary one was removed.
- The base moved during the run and its PR (#169) was then squash-merged, so the commit was rebased onto `origin/main` before the PR was opened.
