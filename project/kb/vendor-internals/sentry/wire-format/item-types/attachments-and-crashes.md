# Attachments and crash items: attachment, unreal_report

Versions: Relay 26.10.0, Sentry 26.10.0. Researched 2026-11-10.

## `attachment`

Item header: `type: attachment`, `length`, `filename`, `content_type`, `attachment_type` (default `event.attachment`). Payload: raw bytes.

| `attachment_type` | Creates an event | Meaning |
|---|---|---|
| `event.attachment` | no | plain file |
| `event.minidump` | yes | native crash, processed by symbolicator |
| `event.applecrashreport` | yes | Apple crash report |
| `event.payload` | yes | msgpack event (`__sentry-event`) |
| `event.breadcrumbs` | yes | msgpack breadcrumbs (`__sentry-breadcrumb1/2`) |
| `event.view_hierarchy` | no | JSON view hierarchy from mobile SDKs |
| `unreal.context`, `unreal.logs` | no | Unreal crash parts |
| `event.nv_gpudmp`, `event.nv_shader_debug` | dump yes / shader no | NVIDIA GPU crash dumps |

Read: [`envelope/attachment.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/attachment.rs), `creates_event` in [`item.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/item.rs).

Attachment v2 (trace attachments): `content_type: application/vnd.sentry.trace-attachment` (alias `application/vnd.sentry.attachment.v2`), header `meta_length` (a JSON meta segment precedes the bytes) and optional `span_id` (attachment of a span, else of the trace). Placeholders: `application/vnd.sentry.attachment-ref+json` with `attachment_length`, pointing to a file already uploaded through the TUS route `/api/{id}/upload/`.

Limits: 200 MiB each, 200 MiB total, 30 per envelope. Categories: `attachment` (bytes) and `attachment_item` (count). Kafka: `ingest-attachments` as `attachment_chunk` messages plus the event message carrying the attachment list (or individual `attachment` messages when no event is in the envelope).

Storage (observed, self-hosted 26.10.0): our 24-byte ASCII file was stored **inline** in Postgres `sentry_eventattachment.blob_path` as `:<content>` (Sentry stores ASCII files under 192 bytes inline, `can_store_inline` in [`models/eventattachment.py`](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/models/eventattachment.py)); larger files go to the filestore under `eventattachments/v1/` (zstd) or to objectstore (`v2/`) where configured. `date_expires` was set to received + 90 days.

An attachment without an event in the envelope got 200; with no event to attach to it is dropped (not traced further).

## `unreal_report`

Raw Unreal Engine 4 crash zip, normally sent to `/api/{id}/unreal/{key}/`. Relay expands it into an event plus attachments (`relay-server/src/utils/unreal.rs`). Category `error`. Observed: a garbage body to the unreal endpoint got 200 with a UUID body and no stored event.
