# fast-tracked tracker

| Guide | Owner | Status | Verified against |
|---|---|---|---|
| `examples/fast-tracked/index.md` | orchestrator | done | the three guides below |
| `examples/fast-tracked/00-stack.md` | fast-tracked-backend | done | `deploy/**` |
| `examples/fast-tracked/10-backend.md` | fast-tracked-backend | done | `examples/backend/**` |
| `examples/fast-tracked/20-frontend.md` | fast-tracked-frontend | done | `sdk/browser/**`, `examples/ouo-web/**` |
| `examples/quickstarts/tiny-shop/` | quickstarts | done (2026-10-23, [summary](summaries/2026-10-23-quickstart-tiny-shop.md)) | `deploy/compose/quickstart.yaml`, `sdk/browser/**` |
| `examples/quickstarts/tiny-shop-otel/` | quickstarts | done (2026-10-25, [summary](summaries/2026-10-25-quickstart-tiny-shop-otel.md)) | `deploy/compose/quickstart.yaml`, `services/rum-api/internal/session` (the contract) |
| `examples/fast-tracked/30-mobile-ios.md` | fast-tracked-mobile | done | `sdk/react-native/**`, `sdk/ios/**`, `examples/ouo-mobile/**`, `project/kb/xcode-setup.md`, `project/kb/ios-replay.md` |

Allowed paths: `examples/fast-tracked/`, `examples/quickstarts/`, `project/agents/fast-tracked/`, index files that list them.

Verification (2026-10-10, orchestrator): the stack guide's OTLP/JSON trace post, Tempo fetch by id, CORS preflight and rum-api `/readyz` were pasted against the running stack on this Mac (override ports) and behaved as described; `go get` versions in the backend guide match `examples/backend/go.mod`; inlined ref files were diffed byte for byte against `examples/ouo-mobile/src/rum.ts` and `examples/ouo-mobile/app.config.ts`; both demo apps typecheck after the port-default fix.
