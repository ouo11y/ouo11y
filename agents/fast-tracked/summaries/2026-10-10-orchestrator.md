# 2026-10-10 orchestrator: fast-tracked onboarding

## Done
- Spawned three writers in parallel: backend+stack (`00-stack.md`, `10-backend.md`), frontend (`20-frontend.md`), mobile iOS (`30-mobile-ios.md`). Each wrote its own summary in this folder.
- Wrote the router `examples/fast-tracked/index.md`, this agent folder, and linked the track from `README.md`, `docs/index.md`, `agents/index.md`.
- Found while reviewing: the demo apps' fallback endpoints (`examples/web/src/rum.ts`, `examples/mobile/src/rum.ts`, `examples/mobile/app.config.ts`, `examples/web/.env.example`) were this Mac's override ports (4328, 8082), which would break a fresh clone. Switched them to the stock ports (4318, 8081), added `examples/mobile/.env.example`, moved the machine-specific values into gitignored `examples/web/.env` and `examples/mobile/.env`, and updated the two demo READMEs, the kb note and the guides' inlined copies.

## Verified
- Live on this Mac's stack: hand-rolled OTLP trace post returns 200 and is fetchable from Tempo; CORS preflight returns the allow headers; rum-api `/readyz` is ready.
- `go get` lines match `go.mod` versions; inlined ref files diff clean; `tsc --noEmit` passes for `examples/web` and `examples/mobile`.

## Not verified
- The guides were not executed end to end by a fresh reader on a clean machine. The mobile writer marked ATS and Local Network prompt behaviour as "not verified in this repo".

## Next agent must know
- Mobile guide assumes stock ports and tells readers to use `examples/mobile/.env` for overrides; Expo CLI loads `.env` into `process.env` for `app.config.ts`.
- Android is still Phase 8 (not started); the mobile guide is iOS only by design.
