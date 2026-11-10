# Files and object storage in self-hosted Sentry 26.10.0 (where replay segments live)

Versions: Sentry 26.10.0, self-hosted 26.10.0, seaweedfs 4.40. Observed 2026-11-10.

## Two blob stores

| Store | Backend | Location | Holds |
|---|---|---|---|
| Filestore (`filestore.backend: filesystem`, `location: /data/files`, [`sentry/config.example.yml`](https://github.com/getsentry/self-hosted/blob/26.10.0/sentry/config.example.yml)) | Django filesystem storage | Docker volume `sentry-data`, mounted at `/data` in `web`, `taskworker` and every Sentry container | **replay segments**, attachments over the inline limit (`eventattachments/v1/`), release files, debug files |
| seaweedfs S3 (`http://seaweedfs:8333`, access key `sentry`) | S3 API | volume `sentry-seaweedfs` | bucket `nodestore` (events, see [nodestore-postgres.md](nodestore-postgres.md)), bucket `profiles` (vroom, `filestore.profiles-backend: s3`) |

Observed `ls /data/files`: `90/` (replays, retention prefix) and `eventattachments/`. seaweedfs `s3.bucket.list`: `nodestore`, `profiles`.

## Replay segments

Code: [`sentry/replays/lib/storage.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/lib/storage.py) `SimpleStorageBlob` (`storage_kv`), used by `commit_recording_message` in [`usecases/ingest/__init__.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/ingest/__init__.py).

- Backend: option `replay.storage.backend`; unset in self-hosted, so `get_storage()` uses the default filestore (filesystem).
- Key: `{retention_days}/{project_id}/{replay_id}/{segment_id}` (`_make_recording_filename`; `retention_days` defaults to 30 when missing). Replay id is 32 hex without dashes.
- Path on disk: `/data/files/90/8/62649a29ef4440bfa140a17c472d1ba3/0` (observed).
- Content:
  - web segment: the zlib-compressed rrweb JSON array exactly as received (or zlib of the raw JSON if the SDK sent it uncompressed). Observed: segment 0, 430 bytes, starts `78 9c`; inflates to our 4 events unchanged.
  - video segment: `zlib( 0x01 + uint32 big-endian video length + MP4 bytes + rrweb JSON )` (`pack()` in [`usecases/pack.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/replays/usecases/pack.py)). Observed: 207-byte file, type byte 1, video length 20.
  - Older "packed rrweb" form: `0x00 + rrweb`; files that start with `[` are unpacked JSON (both readable by `unpack`).
- No Postgres row (`replays_replayrecordingsegment` stays empty); the read path builds the key from `replays_local` (segment count) and opens the file.
- Duplicate segments: the filesystem write overwrites.
- Not written: a segment whose body is gzip (dropped in `decompress_segment`, observed segment 2 missing), a replay_event without recording.

Fixtures: [fixtures/replay-segment-0-decoded.json](fixtures/replay-segment-0-decoded.json), [fixtures/replay-video-segment-0-decoded.json](fixtures/replay-video-segment-0-decoded.json).

To read a segment directly (read-only): `docker exec sentry-sbx-web-1 cat /data/files/<retention>/<project_id>/<replay_id>/<segment_id> | python3 -c 'import sys,zlib; sys.stdout.buffer.write(zlib.decompress(sys.stdin.buffer.read()))'`. Through the API: `GET /api/0/projects/{org}/{project}/replays/{replay_id}/recording-segments/` (see the read-api folder).

## Attachments

[`models/eventattachment.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/models/eventattachment.py): empty → `blob_path NULL`; ASCII and < 192 bytes → inline `:<data>` in Postgres (observed); else `eventattachments/v1/<random path>` in the filestore, zstd-compressed (observed one file at `/data/files/eventattachments/v1/41/e9ff/...` from an earlier project); `v2/<key>` in objectstore when the objectstore service is configured (not in self-hosted 26.10.0).

## Profiles

vroom writes profiles and chunks to the seaweedfs bucket `profiles` (observed prefix `1/` = organization id); metadata goes to ClickHouse. Bucket created by [`install/bootstrap-s3-profiles.sh`](https://github.com/getsentry/self-hosted/blob/26.10.0/install/bootstrap-s3-profiles.sh).

## SaaS differences (read from public source, not observed)

- Replays in SaaS are written to GCS ("Write to GCS" in `commit_recording_message`); keys carry the retention prefix (30/60/90) so a bucket lifecycle rule can expire them (`StorageBlob` docstring).
- Nodestore in SaaS uses Bigtable ([`services/nodestore/bigtable/`](https://github.com/getsentry/sentry/tree/26.10.0/src/sentry/services/nodestore/bigtable)).
- SaaS uses the Rust **objectstore** service ([`src/sentry/objectstore/`](https://github.com/getsentry/sentry/tree/26.10.0/src/sentry/objectstore)) for attachment v2 (`v2/` blob paths, TTL-based expiry) and Relay can upload attachments to it directly (`stored_key` item header, [`services/objectstore.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/services/objectstore.rs)). Self-hosted 26.10.0 does not run it.
