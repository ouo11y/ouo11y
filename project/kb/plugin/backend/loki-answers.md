# Loki answers as a plugin backend sees them

> On our OTLP setup (deploy/compose/loki/config.yaml), what does a `query_range` answer give a backend that reads it, and which LogQL works for sessions?

Verified 2026-11-13 against Loki in env `pluginbff` with `@ouo11y/browser` records (PR #189), and encoded in `libs/ouo-go` (`loki.go`, `ouogo_test.go`).

- **Every attribute is a label in the answer.** Without the `X-Loki-Response-Encoding-Flags: categorize-labels` header, Loki merges structured metadata into each stream's label set. One record's attributes are therefore `result[].stream`, and each distinct attribute set is its own stream. Simple to read; `ouo-go` does not ask for categorized labels.
- **Names have `_` for `.`**, so the original name is lost: `browser.document.url.full` arrives as `browser_document_url_full`. Watch for prefix collisions: `user_agent_original` starts with `user_`, so identity is a list of exact names (`user_id`, `user_email`, ...) plus the prefix `enduser_`, never the prefix `user_` (`libs/ouo-go/redact`).
- **Labels Loki adds** appear next to the attributes: `detected_level`, `observed_timestamp`, `severity_text`, `severity_number`, `scope_name`, `flags`, `trace_id`, `span_id`. `ouo-go` makes ids, event name and severity fields of `Event` and passes the rest as attributes.
- **Stream labels we index**: `service_name`, `service_namespace`, `deployment_environment_name`, `ouo_platform`, `ouo_project_id`, and `event_name` (from `event.name`, which the Collector's `transform/events` copies from the record's event name). `session_id` is structured metadata, so it is a pipeline filter (`| session_id="..."`), never a selector.
- **A selector needs one matcher that cannot match empty**: `{ouo_project_id=~".+"}` works as "every project". Negative matchers also match streams without the label, so `event_name!~"ouo[.]replay[.]chunk"` keeps records that have no event name. `[.]` avoids escaping a dot through Go and LogQL strings.
- **Replay reference records** (one per chunk, COL-6) have `event_name="ouo.replay.chunk"` and an empty body. Leave them out of session timelines and lists, or a few seconds of replay outnumber the session's events.
- **Grouping by structured metadata works in metric queries**: `sum by (ouo_project_id, session_id) (count_over_time({event_name="ouo.replay.chunk"} [86400s]))` returns one series per session. `ouo-go`'s `ListSessions` uses it as the "has replay" hint (Muninn stays the authority, RDR-1).
- **Limits**: one `query_range` returns at most `max_entries_limit_per_query` lines (default 5000). `ListSessions` reads the newest 5000 records of the range and `SessionEvents` the oldest 5000 of a session; both say `truncated` when they hit the limit.
