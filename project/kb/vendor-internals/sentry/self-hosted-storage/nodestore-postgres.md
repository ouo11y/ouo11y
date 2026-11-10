# Nodestore and Postgres in self-hosted Sentry 26.10.0

Versions: Sentry 26.10.0, `sentry-nodestore-s3` 1.0.0, seaweedfs 4.40, Postgres 18.6. Observed 2026-11-10 with read-only queries and object reads. Researched by `sentry-wire-storage`.

## Nodestore: not in Postgres any more

Self-hosted 26.x configures the S3 passthrough backend against the bundled seaweedfs ([`sentry/sentry.conf.example.py`](https://github.com/getsentry/self-hosted/blob/26.10.0/sentry/sentry.conf.example.py), installer [`install/bootstrap-s3-nodestore.sh`](https://github.com/getsentry/self-hosted/blob/26.10.0/install/bootstrap-s3-nodestore.sh)):

```python
SENTRY_NODESTORE = "sentry_nodestore_s3.S3PassthroughDjangoNodeStorage"
SENTRY_NODESTORE_OPTIONS = {"compression": True, "endpoint_url": "http://seaweedfs:8333",
    "bucket_path": "nodestore", "bucket_name": "nodestore", "region_name": "us-east-1", ...}
```

Observed: Postgres `nodestore_node` has **0 rows**; seaweedfs bucket `nodestore` holds 142 chunks (539 KB).

| Aspect | Value |
|---|---|
| Object key | `nodestore/<node_id>` in bucket `nodestore` |
| `node_id` for an event | `md5("<project_id>:<event_id>")` hex (Sentry `Event.generate_node_id`, [`eventstore/models.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/services/eventstore/models.py)) — observed: `md5("8:ff562c37…")` found the object |
| Compression | zstd when smaller, S3 object metadata `Content-Encoding: zstd` (observed, base64 `enN0ZA==`) |
| Value format | `BaseNodeStorage._encode` ([`services/nodestore/base.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/services/nodestore/base.py)): line 1 = default JSON (the normalized event), then pairs of lines `<subkey>` / `<JSON>`; we saw subkey `unprocessed` (the event before enrichment) |
| Caching | only if a Django cache alias `nodedata` exists (`base.py`); self-hosted `CACHES` defines only `default` (memcached), so nodestore reads are not cached |
| Cleanup | `cleanup()` is a no-op unless `delete_through`; expiry is the bucket lifecycle rule (`Expiration.Days = SENTRY_EVENT_RETENTION_DAYS`) set by the installer |

The stored event has every field Relay and Sentry normalized: `event_id, project, type, title, culprit, location, metadata, level, logger, platform, release, environment, timestamp, received, contexts, exception, breadcrumbs, request, user, sdk, tags, fingerprint, hashes, grouping_config, errors (processing errors), _metrics (bytes.ingested/stored), _ref, _ref_version, key_id, nodestore_insert, symbolicated_in_app, version`. Fixture (IPs redacted): [fixtures/nodestore-error-event.json](fixtures/nodestore-error-event.json).

What uses nodestore: error events, transactions, feedback events, issue occurrence events. Replays, spans, logs and metrics are **not** in nodestore.

## Postgres tables relevant to us

331 tables in `public`. Observed rows for project `step6-wire` (id 8):

| Table | What | Observed for project 8 |
|---|---|---|
| `sentry_project`, `sentry_projectkey` | projects and DSN keys (key has `rate_limit_count`, `rate_limit_window`, `status`) | 1 key |
| `sentry_groupedmessage` | issues (`id`, `short_id`, `type` 1 = error, 6001 = feedback, 4001 = cron, `status`, `times_seen`, `first_seen`, `last_seen`, `data` JSON metadata) | 9 groups after our tests |
| `sentry_grouphash` | fingerprint hash → group | 1 per group |
| `sentry_release`, `sentry_release_project`, `sentry_releaseprojectenvironment`, `sentry_environment` | releases seen in events/sessions | `step6-wire@1.0.0` |
| `sentry_userreport` | legacy user reports and feedback shims (`event_id`, `name`, `email`, `comments`, `group_id`) | 1 |
| `sentry_eventattachment` | attachment metadata; `blob_path` `:<data>` for inline (< 192 B ASCII), `eventattachments/v1/...` for filestore, `v2/...` for objectstore; `date_expires` | 1, inline |
| `sentry_file`, `sentry_fileblob`, `sentry_fileblobindex` | filestore index for release files, debug files, legacy replay segments | — |
| `replays_replayrecordingsegment` | legacy replay segment index (`FilestoreBlob`) | **0 rows**: 26.x writes segments by key, without this table |
| `replays_replaydeletionjob` | bulk replay deletes | — |
| `sentry_monitor`, `sentry_monitorcheckin`, `sentry_monitorenvironment` | crons | 1 monitor, 1 check-in |
| `sentry_stringindexer` | metric tag/name string ids (sessions) | — |
| `nodestore_node` | legacy nodestore | 0 rows |

Postgres holds no telemetry rows except attachments metadata (and tiny inline attachments), user reports and check-ins.
