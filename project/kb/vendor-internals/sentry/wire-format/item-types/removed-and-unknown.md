# Unknown, renamed and removed item types

Versions: Relay 26.10.0. Researched 2026-11-10.

## Unknown types

Any `type` string not in `ItemType::from_str` becomes `ItemType::Unknown(name)` ([`envelope/item.rs`](https://github.com/getsentry/relay/blob/26.10.0/relay-server/src/envelope/item.rs)). A non-processing (proxy/static) Relay forwards it unchanged for forward compatibility. A processing Relay, which is what self-hosted runs (`processing.enabled: true`), removes it (`utils::remove_unknown_items` when `routing.accept_unknown_items` is false). If nothing else is left the request still gets 200 (observed `item-unknown-type.json`: 200 `{}`). An unknown `attachment_type` also makes the item "unknown". No outcome is produced for unknown items (they have no category).

## Names that are not item types in Relay 26.10.0

| Name | What happened | Where the data goes now |
|---|---|---|
| `user_report_v2` | Internal enum name; the wire string is `feedback` | [events-and-feedback.md](events-and-feedback.md) |
| `nel` | Not an item type. `/api/{id}/nel/` endpoint wraps reports in an internal `integration` item | EAP logs |
| `otel_span` | Removed. OTLP spans come through `/integration/otlp/v1/traces` as internal `integration` items | EAP spans, [../otlp-ingest.md](../otlp-ingest.md) |
| `otel_log` | Removed, same as above with `/v1/logs` | EAP logs |
| `statsd`, `metric_meta` | Removed with the custom metrics beta | unknown → dropped |
| `checkin` | Old spelling; current is `check_in` | unknown → dropped |

If an old SDK still sends one of the removed names, Relay 26.10.0 answers 200 and drops the item silently. A bridge that wants parity with Sentry should forward such items unchanged and not count on them being stored.
