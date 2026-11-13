# Durable hand-off with stock Collector components

> Can the stock OTLP receiver, routing connector and `otlp_http` exporter give "the SDK gets 2xx only after the chunk is on disk with fsync" (SDK spec TRN-12)? What is checked and what is not?

Checked on 2026-11-11 by reading the Collector v0.160.0 modules in the local Go module cache (the version in [builder.yaml](../../../../collector/builder.yaml)), by the author and again by the reviewer of the pull request. Nothing was run. Confidence per row.

## Why it should work

Every component between the receiver and the exporter's queue is called synchronously, and the queue write happens before the call returns:

1. The OTLP receiver calls the pipeline and builds the HTTP answer from the returned error.
2. Processors without their own goroutine (memory limiter, rate limit, resource) pass the call through. The **batch processor does not**: it returns at once and exports later, so a failure after it is never seen by the receiver. The replay pipeline therefore has none.
3. A connector calls the next pipeline in the same call.
4. The exporter's sending queue stores the request and returns. With `storage:` set, the store is the file storage extension.

## Checked in source

| Fact | Where | Confidence |
|---|---|---|
| A pipeline error that is not permanent and carries no gRPC status becomes `Unavailable`, which the HTTP receiver answers as **503**. `ResourceExhausted` becomes 429 | `receiver/otlpreceiver/internal/errors/errors.go` | High |
| The sending queue's settings are `enabled`, `queue_size`, `sizer`, `storage`, `block_on_overflow`, `wait_for_result`, `num_consumers`, `batch` | `exporter/exporterhelper/internal/queuebatch/config.go` | High |
| The persistent queue writes the item and its index to the storage client in one `Batch` call inside the put, before returning | `exporter/exporterhelper/internal/queue/persistent_queue.go` | High |
| The `otlp_http` exporter retries only 429, 502, 503 and 504, and reads `Retry-After` on 429 and 503 | `exporter/otlphttpexporter/otlp.go` | High |
| The `otlp_http` exporter reads a partial-success body, logs a warning and returns success. It does not retry it and counts nothing | same file | High |
| The routing connector accepts a condition on the scope name in the log context. Its log parser enables the path contexts `log`, `scope`, `instrumentation_scope` (older alias), `resource` and `otelcol` | `connector/routingconnector` (contrib) | High |
| An error from one of two routed pipelines reaches the receiver: the connector joins and returns consumer errors whatever `error_mode` is, and the fan-out calls every consumer | `connector/routingconnector`; fan-out read at v0.162.0, the only cached version | Medium |
| A full queue with `block_on_overflow: false` returns `ErrQueueIsFull`, a plain non-permanent error, so the receiver answers 503 | `exporter/exporterhelper` | High |
| `sizer: bytes` works with a persistent queue; the byte size is persisted | `exporter/exporterhelper` | High |
| `set(log.body, nil)` does **nothing** in OTTL at v0.160 unless feature gate `ottl.set.allowNil` is on (alpha, off by default): it logs one warning and leaves the body. A reference copy built with it would send the full chunk to Loki | `pkg/ottl/ottlfuncs/func_set.go` (contrib) | High |
| The fan-out deep-copies the request for a pipeline that mutates, so the reference pipeline costs one extra copy of the body per chunk | fan-out, v0.162.0 | Medium |
| The persistent queue holds its mutex across the storage write on enqueue, and writes again on dispatch and on completion: about three serialised storage transactions per chunk | `exporter/exporterhelper/internal/queue/persistent_queue.go` | High |

These match the SDK retry table (TRN-6), so both hops behave the same way.

## Not checked, to test before the config is written

| Open point | How to test |
|---|---|
| The file storage extension's `fsync` setting exists in v0.160 and makes each `Batch` durable. The module is not in the local cache | Add `extension/storage/filestorage` to `builder.yaml`, set `fsync: true`, kill -9 the Collector right after a 2xx, restart, count chunks at a fake Muninn |
| Routing, error propagation and the full-queue answer, read in source above, behave the same when run | One end-to-end test: mixed request, then fill the queue and expect 503 at the SDK side while telemetry still gets 2xx |
| Cost of the synced writes | Measure chunks per second on the CI runner's disk. At 12 chunks per recording minute per session, 1000 concurrent recording sessions are 200 chunks per second, so about 600 synced transactions per second through one mutex |
| The Loki copy really has no chunk bytes | Assert on the record Loki stores |
| Memory with 1 MiB chunks, given the extra copy | Heap profile |
| Request metadata (the authenticated project) is not needed after the queue, because `resource/project` stamps it before | Covered by the end-to-end test |

## Sketch of the configuration

Illustrative, not tested. It is a **new configuration for the spec wire only**: it has no MVP replay receiver or exporter, no rum-api, and no Sentry bridge, and it is not meant to be merged into the current `deploy/compose/collector/config.yaml`. Key names are from the source read above except where the table says otherwise.

```yaml
extensions:
  file_storage/replay:
    directory: /var/lib/otelcol/replay-queue
    fsync: true

connectors:
  routing/replay:
    error_mode: propagate          # the default ignores a failing condition and would send a chunk, body included, to the logs pipeline
    default_pipelines: [logs]
    table:
      - context: log
        condition: scope.name == "ouo.replay"
        pipelines: [logs/replay, logs/replay-index]

processors:
  transform/replay-ref:
    error_mode: propagate
    log_statements:
      - context: log
        statements:
          - set(log.attributes["ouo.replay.ref"], Concat(["muninn:", resource.attributes["ouo.project.id"], log.attributes["session.id"], log.attributes["ouo.replay.id"], log.attributes["ouo.replay.stream.id"], String(log.attributes["ouo.replay.sequence"])], "/")) where log.event_name == "ouo.replay.chunk"
          - set(log.body, "") where log.event_name == "ouo.replay.chunk"   # not nil: see the table above

exporters:
  otlp_http/muninn:
    logs_endpoint: http://muninn:3400/otlp/v1/logs
    compression: none
    timeout: 30s
    headers:
      Authorization: Bearer ${env:MUNINN_INGEST_TOKEN}
      X-Scope-OrgID: ${env:MUNINN_TENANT}      # one tenant per Collector in the first version
    sending_queue:
      enabled: true
      storage: file_storage/replay
      sizer: bytes
      queue_size: 2147483648
      block_on_overflow: false
      num_consumers: 4
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 60s
      max_elapsed_time: 0

service:
  pipelines:
    logs/in:
      receivers: [otlp]
      processors: [memory_limiter, ouoratelimit, resource/project]
      exporters: [routing/replay]
    logs:
      receivers: [routing/replay]
      processors: [transform/events, batch]
      exporters: [otlp_http/loki]
    logs/replay:
      receivers: [routing/replay]
      exporters: [otlp_http/muninn]
    logs/replay-index:
      receivers: [routing/replay]
      processors: [transform/replay-ref, batch]
      exporters: [otlp_http/loki]
```

`ouo.replay.ended` records pass through `logs/replay-index` unchanged, since both statements apply to chunks only.
