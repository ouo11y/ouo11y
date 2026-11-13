# The stock Collector path to Muninn: what running it showed

> The design (PR #180, `project/kb/muninn/collector-path/durable-handoff.md` on that branch) read the Collector v0.160 source and listed what still needed a test. What did building and running `deploy/compose/collector/config.muninn.yaml` settle, and what is still open?

Checked on 2026-11-13 in ouo-env `muninn-collector-build-43a659` (ouo-collector 0.5.0 built from `collector/builder.yaml`, Muninn on MinIO), with `tests/e2e/muninn/run.mjs` and the logs of both services.

## Settled by running it

| Point | Result | How |
|---|---|---|
| `file_storage` with `fsync: true` exists at v0.160.0 | Yes. The extension is its own Go module, `extension/storage/filestorage` (see [build-notes.md](build-notes.md)); `create_directory`, `fsync` and `timeout` are accepted and the Collector starts | `ouo-collector validate` and the running stack |
| Routing by scope in the log context | `condition: instrumentation_scope.name == "ouo.replay"` with `context: log` and `error_mode: propagate` routes the SDK's chunks to `logs/replay` and `logs/replay-index`, everything else to `logs` | Every browser chunk reached Muninn and Loki, other events stayed in `logs` |
| Reference copy | `Concat([...], "/")` with `String(log.attributes["ouo.replay.sequence"])` builds `muninn:/<project>/<session>/<replay>/<stream>/<seq>`; `set(log.body, "")` empties the body. Loki holds one record per chunk with that ref and an empty line | LogQL `{service_name="muninn-e2e"} \| ouo_replay_ref!=""` |
| Chunk bytes unchanged on both hops | Every body Muninn serves is byte-for-byte inside a request the SDK sent | e2e check |
| Muninn down | The Collector answers the SDK 200, keeps the chunk in the disk queue and delivers it about 10 s after Muninn starts again (`retry_on_failure` backoff) | e2e: `docker compose stop muninn`, send, `start` |
| Muninn rejects through partial success | The exporter drops the record (logs a warning); the SDK got its 200 from the Collector; nothing is stored | e2e: chunk with a wrong SHA-256 through the Collector |
| Request metadata after the queue | Not needed: `resource/project` stamps `ouo.project.id` before the routing, and Muninn reads it from the resource | Every stored chunk has project `demo` |

## Still not tested

- **kill -9 of the Collector right after a 2xx** (COL-4, durability of the fsync-ed queue). The queue survived Muninn being down, not a Collector crash.
- **Full queue answers 503** (COL-5) while telemetry keeps flowing. Needs `OUO_REPLAY_QUEUE_BYTES` set small and a load generator.
- **Throughput of the synced queue** on real disks (the design's 600 synced transactions per second estimate).
- **Memory with 1 MiB chunks** given the fan-out copy.
