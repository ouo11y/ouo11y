# 2026-10-30 W3 delivery: gzip OTLP, outbox, durable chunk queue, keep/drop

Branch `claude/w3b-delivery`, the delivery half of work package W3 of [roadmap.md](../../../kb/mobile-sdk-research/roadmap.md) (§3, §10), checklist N48 and N49, mobile spec C11. The tiles half (schema 2, player) is W3a, a parallel session. Env `w3b-delivery`, simulator `w3b-delivery` (9E602997-2F45-4D2C-98D9-9E7D2ECF5AB2, iPhone 17 Pro, iOS 27).

## What was done

- **React Native, OTLP delivery** (`sdk/react-native/src/transport/`):
  - `Outbox`: every OTLP batch is written to AsyncStorage before it is sent and removed on 2xx or on a final rejection. Network errors, 408, 429 and 5xx keep it.
  - One sender, oldest first. Retry 1 s doubling to 30 s, `Retry-After` honoured. It drains on the next launch (`rum.ready`), on foreground, on `rum.flush()` and after the backoff.
  - Bounds: 5 MB, 500 entries, 24 h, the oldest dropped first.
  - `OutboxExporter` replaces the OTel HTTP exporters. It serialises with `@opentelemetry/otlp-transformer` and resolves once the batch is persisted.
  - `createSend`: native `postOtlp` (gzip + `URLSession`, off the JS thread), or `fetch` uncompressed where the module is absent.
  - New option `transport.offline` (bounds, or `false`).
- **iOS chunk queue** (`ChunkUploader`):
  - The queue is a folder, `Application Support/ouo/replay/outbox/`, excluded from backup. One file per chunk, the exact gzip body, named `<queued ms>-<n>.<session>.<seq>.json.gz`.
  - Written synchronously in `enqueue`, deleted on 2xx or rejection. Retry 1 s doubling to 60 s, on the next chunk, on `drain` and in the next process. Bounds: 10 MB, 24 h (`ChunkSpool.maxAge`).
  - If the disk write fails, the chunk gets one attempt from memory.
  - `maxAttempts` is gone: network failures are never given up on, only bounded.
  - One uploader per process (`OuoReplay.uploader(config)`). `recoverSpool` also starts sending what earlier processes left.
- **Next-launch keep/drop** (Luciq's sync callback, roadmap item 13): `replay.keepAtNextLaunch(session) => boolean | Promise<boolean>`.
  - With it set, native `holdUploads` puts chunks in `outbox/held/`.
  - At `rum.ready` the SDK asks the hook about every held session but the current one, with `{ sessionId, chunks, bytes, firstChunkAt, lastChunkAt, crashed, errors }`. Native then sends or deletes the session's chunks (`heldReplaySessions` / `releaseHeldReplay`); the listing runs on the capture queue after spool recovery.
  - Error counts persist in `ouo.replay.errors`. Without the hook, anything held is sent.
- **Expo bridge:** `postOtlp`, `heldReplaySessions`, `releaseHeldReplay`, and `holdUploads` in the start options.
- **Conformance suite** (`tests/e2e/mobile`, from W2): C11.1 and C11.2 are no longer `pending`. The native stand-in models the new native behaviour: `postOtlp` (gzip), the chunk queue folder written before upload and drained oldest first, and held sessions.
- **Docs:** `docs/specs/mobile-sdk.md` C11 is no longer draft: it states the bounds, and the matrix moves React Native iOS C11 to L2. `docs/specs/mobile-replay.md` gains two chunk rules (durable queue, keep/drop). The RN README gains "Delivery and offline (C11)". New kb [mobile-delivery.md](../../../kb/mobile-delivery.md); checklist N48 and N49 closed.
- **Dependencies:** `@opentelemetry/exporter-logs-otlp-http` and `@opentelemetry/exporter-trace-otlp-http` were removed. They now go unused: their transport is replaced, and they pulled in `otlp-exporter-base`. `@opentelemetry/otlp-transformer` (^0.222.0) was added: it provides the OTLP JSON serializers, was already installed as a dependency of the removed exporters, and is a direct dependency of the browser SDK.

## Verified, and how

- `sdk/react-native`: `tsc --noEmit` clean, 150 Vitest tests. The 19 new ones:
  - `test/delivery.test.ts`:
    - an outage across launches;
    - backoff sequence and `Retry-After`;
    - a put during the backoff;
    - rejections;
    - a kill mid-request;
    - byte and entry bounds;
    - max age;
    - an index entry with no body;
    - failing storage;
    - native vs `fetch` send;
    - `Retry-After` parsing;
    - UTF-8 decode without `TextDecoder`;
    - C11.1 end to end through `initRUM`;
    - `offline: false`.
  - `replay.test.ts`: three keep/drop cases.
- `sdk/ios`: `swift test`, 74 Core tests and 6 crash tests. `ChunkUploaderTests` was rewritten for the folder queue: an outage across processes, a kill mid-upload, rejection, bound, max age, held sessions, file names.
- Simulator, `examples/ouo-mobile` Release build against env `w3b-delivery`, scripted journey (`scripts/journey.sh`):
  - **Online baseline:** 45 timeline events, 13 traces, 7 replay chunks / 11 frames. The outbox folder is empty afterwards.
  - **Collector container stopped** (OTLP and replay ports refused, backend up): the device held 30 OTLP batches (94 KB raw) and 7 chunks (175 KB). The next launch with the collector back delivered everything:
    - the offline session has 46 events (the same 45 plus its `session.end`), 13 traces, 7 chunks / 12 frames;
    - both stores ended empty;
    - a launch in between that was still offline added more items, and those were delivered too.
    - **C11.1 holds.**
  - **gzip:** a header-logging stub on the OTLP port saw 30 of 30 requests with `content-encoding: gzip`, 94,143 B -> 24,309 B. **C11.2 holds.**
  - **Keep/drop**, with a temporary `keepAtNextLaunch: (s) => s.chunks >= 3` in the example (not committed):
    - the journey's chunks stayed held while spans and events arrived live;
    - the next launch sent the 7 chunks;
    - the launch after deleted the 1-chunk idle session, which never reached rum-api.
- **Conformance suite** against env `w3b-delivery` (`node tests/e2e/mobile/conformance.mjs`, after the rebase onto W2): `CONFORMANCE OK`, 13 required checks pass and 5 pending (W4, W5, W6). C11.1 and C11.2 pass, and C11 Delivery is at L2.
- `lychee --offline` clean.

## Left, and what the next session must know

- **ChunkBuilder window:** `ChunkBuilder.cut()` clears the spool before `onChunk` writes the chunk to the queue. A kill during that chunk's gzip (milliseconds) loses it. The fix is to clear the spool after `onChunk`, in W3a's file; W3a was told.
- **CPU:** CPU with gzip was not re-measured. W3's B3 run after tiles measures bytes per minute and CPU together.
- **Android:** the Android native module is a stub, so React Native Android sends OTLP uncompressed and has no chunk queue (W9).
- **Process:** this session was started in the same folder as W3a. Both sessions' edits mixed there until this session moved to its own worktree, `.claude/worktrees/w3b-delivery`. Start every session in its own worktree.
