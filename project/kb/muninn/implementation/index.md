# Muninn: building it

What was learned building `services/muninn` and `deploy/compose/collector/config.muninn.yaml` (agent [muninn-build](../../../agents/muninn-build/index.md)). The design itself (ADR-0019, `docs/specs/muninn.md`, `project/kb/muninn/collector-path/`) is in PR #180.

| Entry | What it answers |
|---|---|
| [collector-path-verified.md](collector-path-verified.md) | Which of the design's untested Collector points running the stack settled, and which are still open |
| [gzip-on-the-read-path.md](gzip-on-the-read-path.md) | Node `fetch`, Go's transport and Traefik decompress gzip chunks behind the reader's back; send `Accept-Encoding: gzip` |
| [build-notes.md](build-notes.md) | ocb and the `filestorage` module, minio-go create-only writes, the filesystem create-only recipe, the SDK's OTLP value types |
