# Where the Sentry bridge's output lands next to Muninn

Checked 2026-11-15 on `origin/main` (a8301a00) with a live stack (`ouo-env up <env> --muninn`). Report: [bridge-muninn-lgtm.html](../../../agents/sentry-demo/reports/bridge-muninn-lgtm.html).

## Before this change

- `config.yaml` (default stack, the VM install) runs the bridge (`ouosentry`, :4320). Errors, sessions, logs, vitals and breadcrumbs go to Loki, transactions to Tempo, `replay_video` segments to rum-api through the `ouoreplay` exporter (`kind: "video"`, base64 mp4 inside JSON).
- `config.muninn.yaml` (the `--muninn` stack) has **no** bridge at all: compose still publishes :4320 and `ouo-env` prints a Sentry DSN host for it, but nothing listens. ADR-0019 left the MVP `ouosentry` out of the spec-wire configuration on purpose.
- Mimir gets nothing from the bridge directly: transactions become Tempo span metrics (`traces_spanmetrics_*{service="sentry-demo"}`), and the bridge counts itself (`ouo_sentry_envelopes_total`, `ouo_sentry_items_total`, drops). Mobile vitals are log events in Loki (`ouo.app.start`, `ouo.screen.display`, `app.jank`, `ouo.stall`), not metrics.

## Why bridged replays cannot go to Muninn by configuration alone

The bridge emits one log record per segment whose body is the MVP JSON chunk (`kind: "video"`, `video.mp4` base64, touches) with `ouo.replay.chunk = true`, `ouo.replay.seq`, `ouo.replay.kind`, in the receiver's own scope. Muninn accepts only spec-wire records ([muninn.md](../../../../docs/specs/muninn.md) section 3): scope `ouo.replay`, `event_name` `ouo.replay.chunk`, the mp4 as raw bytes, `ouo.replay.id`, `stream.id`, `sequence`, `segment.index`, `keyframe`, `sha256`, `byte_size` and more. OTTL could parse the JSON but not turn base64 into a bytes body and hash it reliably, and ADR-0019 says the new configuration "does not accept, translate or forward" the MVP envelope. The fix belongs in the receiver: emit `ouo-video/1` records ([mobile-replay.md](../../../../docs/specs/mobile-replay.md)) itself. The plan is in the report.

## What this change does

`deploy/compose/collector/config.muninn-sentry.yaml` is merged over `config.muninn.yaml` (two `--config` flags; maps merge, lists are replaced, so the `traces` and `logs` pipelines are restated). The `--muninn` stack now runs both: spec-wire replay to Muninn, bridge output to Loki and Tempo, bridged video to rum-api (where today's plugin reads it). The `logs` pipeline takes two connectors as receivers (`routing/replay`, `routing/sentry`); a connector can feed a pipeline next to another one.

## Watch out

- Open PR ouo11y/ouo11y#208 (remove rum-api) makes `config.yaml` = spec wire + bridge and sends bridged replay segments to `debug`: from then on Sentry replays are stored nowhere until the receiver emits `ouo-video/1`. It also deletes `compose.muninn.yaml`, which makes this overlay moot.
- The bridge answers the SDK before it translates (`receiver.go`, `forward` then `enqueue`), so the spec's COL-4 ("2xx only after the disk queue write") cannot hold for bridged replays: a full or broken replay queue is a counted drop (`consumer_replay`), never a 503 to the SDK. With a real upstream, Sentry still has the segment.
