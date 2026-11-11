# Durable hand-off with stock Collector components

> Can the stock OTLP receiver, routing connector and `otlp_http` exporter give "the SDK gets 2xx only after the chunk is on disk with fsync" (SDK spec TRN-12)? What is checked and what is not?

Checked on 2026-11-11 by reading the Collector v0.160.0 modules in the local Go module cache (the version in [builder.yaml](../../../../collector/builder.yaml)). Nothing was run. Confidence per row.

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
| The `otlp_http` exporter reads a partial-success body and reports it; it does not retry it | same file | High |

These match the SDK retry table (TRN-6), so both hops behave the same way.

## Not checked, to test before the config is written

| Open point | How to test |
|---|---|
| The file storage extension's `fsync` setting exists in v0.160 and makes each `Batch` durable. The module is not in the local cache | Add `extension/storage/filestorage` to `builder.yaml`, set `fsync: true`, kill -9 the Collector right after a 2xx, restart, count chunks at a fake Muninn |
| The routing connector accepts a condition on the scope name in the log context (`instrumentation_scope.name == "ouo.replay"`) | Config test with a mixed request |
| An error from one of two routed pipelines reaches the receiver | Fill the queue, expect 503 at the SDK side |
| A full queue with `block_on_overflow: false` returns a non-permanent error | Same test. If it is permanent, the receiver answers 500, which the SDK does not retry, and a small processor or `wait_for_result` is needed |
| Cost of one fsync per chunk | Measure chunks per second on the CI runner's disk. At 12 chunks per recording minute per session, 1000 concurrent recording sessions are 200 writes per second |
| `sizer: bytes` works with a persistent queue and `queue_size` in bytes | Config test |
| Memory: the routing connector gives two pipelines the same data; the reference pipeline drops the body | Heap profile with 1 MiB chunks |
| Request metadata (the authenticated project) is not needed after the queue, because `resource/project` stamps it before | Covered by the end-to-end test |

## Sketch of the configuration

Illustrative, not tested. Key names are from the source read above except where the table says otherwise.

```yaml
extensions:
  file_storage/replay:
    directory: /var/lib/otelcol/replay-queue
    fsync: true

connectors:
  routing/replay:
    default_pipelines: [logs]
    table:
      - context: log
        condition: instrumentation_scope.name == "ouo.replay"
        pipelines: [logs/replay, logs/replay-index]

processors:
  transform/replay-ref:
    log_statements:
      - context: log
        statements:
          - set(log.attributes["ouo.replay.ref"], Concat(["muninn:", resource.attributes["ouo.project.id"], log.attributes["session.id"], log.attributes["ouo.replay.id"], log.attributes["ouo.replay.stream.id"], String(log.attributes["ouo.replay.sequence"])], "/")) where log.event_name == "ouo.replay.chunk"
          - set(log.body, nil) where log.event_name == "ouo.replay.chunk"

exporters:
  otlp_http/muninn:
    logs_endpoint: http://muninn:3400/otlp/v1/logs
    compression: none
    timeout: 30s
    headers:
      Authorization: Bearer ${env:MUNINN_INGEST_TOKEN}
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
