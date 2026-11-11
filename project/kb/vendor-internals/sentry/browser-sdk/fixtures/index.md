# Sentry browser SDK wire fixtures

Envelopes captured byte for byte by `sentrytap` between `@sentry/react` 11.11.0 (Chromium 152) and self-hosted Sentry 26.10.0, project `step6-browser`, on 2026-11-10. How they were made and what every field means: [../wire-capture.md](../wire-capture.md).

- Each capture has the raw body (`.envelope` when it is all text, `.envelope.bin` when it holds binary) and a `.http.json` with the request line, the relevant request headers and the response.
- Binary captures also have a `.decoded.json`: envelope header, item headers, decompressed rrweb events for `replay_recording`, and a size/magic-bytes note for binary attachments.
- Redaction: DSN public key replaced by 32 zeros everywhere (query string, DSC, baggage, network bodies inside replay), time zone replaced by `Etc/Redacted`. Both keep the byte length, so item `length` headers stay valid. The replay recordings that contained the key (`replay-session-seg1`, `replay-buffer-seg0-on-error`, `replay-canvas-static-seg1`) were decompressed, redacted and recompressed with zlib level 6, so their bytes differ from the wire and `body_len` in their `.http.json` is the original length. All other files are the exact wire bytes after the same-length replacements.
- Event, trace, replay and profiler ids are real and can be looked up in the self-hosted Sentry.
- Decode any of them with `python3 -I examples/sentry-web/scripts/decode_captures.py <dir>` (see [the demo README](../../../../../../examples/sentry-web/README.md)).

| Path | What it is |
|---|---|
| [session-init.envelope](session-init.envelope) | What does the first release-health session update look like (`init:true`, `ip_address:"{{auto}}"`)? |
| [session-unhandled.envelope](session-unhandled.envelope) | What does a session update look like after the first unhandled error (`status:"unhandled"`, `errors:1`, `did`)? |
| [session-429-rate-limited.envelope](session-429-rate-limited.envelope) | Which headers does a 429 with `X-Sentry-Rate-Limits` carry (see its `.http.json`)? |
| [event-error-thrown.envelope](event-error-thrown.envelope) | What does an unhandled error from a timer look like, with breadcrumbs, DSC header and `tags.replayId`? |
| [event-linked-errors.envelope](event-linked-errors.envelope) | How is an `Error` with a `cause` sent (`mechanism.type:"chained"`, `exception_id`, `parent_id`)? |
| [event-capture-message.envelope](event-capture-message.envelope) | Why does a v11 `captureMessage` carry a synthetic exception and stack? |
| [event-react-error-boundary.envelope](event-react-error-boundary.envelope) | What does a React render error look like when `reactErrorHandler` on `createRoot` reports it (`mechanism.type:"auto.function.react.error_handler"`, `handled:false`)? |
| [event-http-client-error.envelope](event-http-client-error.envelope) | What does `httpClientIntegration` send for a 503? |
| [event-with-text-attachment.envelope](event-with-text-attachment.envelope) | How does a scope attachment travel with its event (`length`, `filename`, `content_type`)? |
| [feedback-with-screenshot.envelope.bin](feedback-with-screenshot.envelope.bin) | What do a `feedback` item and its PNG screenshot attachment look like? |
| [span-v2-pageload.envelope](span-v2-pageload.envelope) | What does the v11 default span v2 container hold for a pageload (segment plus 9 children, typed attributes)? |
| [span-v2-inp-click.envelope](span-v2-inp-click.envelope) | How is INP sent as a standalone span? |
| [transaction-static-pageload.envelope](transaction-static-pageload.envelope) | What does the legacy transaction look like with `traceLifecycle:'static'`? |
| [log-container.envelope](log-container.envelope) | What does a log container look like (`logger.*`, `logger.fmt`, console logs)? |
| [trace-metric-container.envelope](trace-metric-container.envelope) | What do counter, gauge and distribution metrics look like? |
| [profile-chunk.envelope](profile-chunk.envelope) | What does a UI profiling chunk look like (frames, samples, stacks)? |
| [client-report-before-send.envelope](client-report-before-send.envelope) | Which client report does `beforeSend` returning null produce? |
| [client-report-sample-rate.envelope](client-report-sample-rate.envelope) | Which client report does `sampleRate: 0` produce (with `no_parent_span`)? |
| [client-report-ratelimit-backoff.envelope](client-report-ratelimit-backoff.envelope) | Which client report follows a 429 with categories? |
| [client-report-network-error-cors.envelope](client-report-network-error-cors.envelope) | What does the SDK report when a 429 lacks CORS headers (`network_error`)? |
| [replay-session-seg0.envelope.bin](replay-session-seg0.envelope.bin) | What is in the first segment of a session-mode replay (Meta, FullSnapshot, options)? |
| [replay-session-seg1.envelope.bin](replay-session-seg1.envelope.bin) | What does an incremental segment hold (inputs, breadcrumbs, network details)? |
| [replay-buffer-seg0-on-error.envelope.bin](replay-buffer-seg0-on-error.envelope.bin) | What does buffer mode send when an error happens (`replay_type:"buffer"`, `error_ids`)? |
| [replay-buffer-seg1.envelope.bin](replay-buffer-seg1.envelope.bin) | What follows the buffered segment after conversion? |
| [replay-canvas-static-seg1.envelope.bin](replay-canvas-static-seg1.envelope.bin) | What does a segment look like with `replayCanvasIntegration` on (no canvas events in a hidden pane)? |
| `*.decoded.json` | Decoded view of each `.envelope.bin` (same name) |
| `*.http.json` | Request line, headers and response for each envelope (same name) |
