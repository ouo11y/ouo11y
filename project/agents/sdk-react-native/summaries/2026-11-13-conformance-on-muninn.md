# 2026-11-13 — the RN conformance suite reads replay from Muninn (PR 184)

## What was done

- **Bug found and fixed in the SDK**: `session.id` (and feedback ids) were UUIDs with dashes. Muninn rejects a chunk whose `session.id` is not 32 lowercase hex (SES-1, `docs/specs/muninn.md` 3.3), so every replay chunk of 184 got a 2xx from the Collector and was then dropped (`bad_id` partial success in the Collector log). `src/session/ids.ts` now writes 32 hex characters, as `@ouo11y/browser` does; five unit tests updated; CHANGELOG entry.
- **Stand-in** (`tests/e2e/mobile/standin.cjs`): models 184's native module: one `ouo.replay.chunk` OTLP protobuf request per chunk to `options.otlp.logsUrl`, no `Content-Encoding`, replay and stream ids per session kept on disk, `ouo.replay.ended` on rotation (`session_end`), `stop`, `endSession` and crash recovery (`crash`). Replay requests are marked `replay: true` in the request log and never get an injected fault.
- **Checks** (`tests/e2e/mobile/conformance.mjs`): C8.1, C8.3, C10.1 read Muninn's read API (7.1, 7.2) instead of rum-api; C11.2 and C11.3 cover telemetry requests only. `tests/e2e/lib.mjs` has `MUNINN` and `MUNINN_READ_TOKEN`. `launch.cjs` drops the removed `replayEndpoint`.
- **CI** (`examples (journey + verify)`): sentry-mobile runs before a new step that brings the stack up again with `compose.muninn.yaml` (that config has no Sentry bridge and no MVP replay receiver); the ouo-mobile legs run after it. `stack-env.sh` gives Muninn port 20N40 on the runners (Grafana's port + 40), 3400 otherwise. The ouo-mobile path filter includes `services/muninn`.

## Verified, and how

- `ouo-env up c184mun --muninn`, then `node tests/e2e/mobile/conformance.mjs`: 19/19 required checks pass (before the id fix: 16/19, C8.1, C8.3, C10.1 failing with no replay in Muninn).
- The playground leg and `examples/ouo-mobile/scripts/verify.py` on the same stack: 14/14.
- `npx vitest run` 322/322, `tsc --noEmit` clean, `lychee --offline` clean.

## Left, and what the next agent must know

- A session persisted by an older SDK keeps its dashed id until it rotates; its replay chunks are still dropped by Muninn.
- Real devices were not rerun after the id change; native code takes the id as an opaque string.
- `tests/e2e/mobile-android` still has the C1.1 (10 s background below the 60 s clamp), C11.2 (replay without gzip) and C8.2 (old store) issues of the 2026-11-13 simulator check.
- `ouo-env env` does not export `OUO_BACKEND_URL`; set it by hand for the suite.
- Env `c184mun` was torn down at the end of this run.
