# fast-tracked tracker

| Guide | Owner | Status | Verified against |
|---|---|---|---|
| `examples/fast-tracked/index.md` | orchestrator | done | the three guides below |
| `examples/fast-tracked/00-stack.md` | fast-tracked-backend | done | `deploy/**` |
| `examples/fast-tracked/10-backend.md` | fast-tracked-backend | done | `examples/backend/**` |
| `examples/fast-tracked/20-frontend.md` | fast-tracked-frontend | done | `sdk/browser/**`, `examples/web/**` |
| `examples/fast-tracked/30-mobile-ios.md` | fast-tracked-mobile | done | `sdk/react-native/**`, `sdk/ios/**`, `examples/mobile/**`, `project/kb/xcode-setup.md`, `project/kb/ios-replay.md` |

Allowed paths: `examples/fast-tracked/`, `project/agents/fast-tracked/`, index files that list them.

Verification (2026-10-10, orchestrator): the stack guide's OTLP/JSON trace post, Tempo fetch by id, CORS preflight and rum-api `/readyz` were pasted against the running stack on this Mac (override ports) and behaved as described; `go get` versions in the backend guide match `examples/backend/go.mod`; inlined ref files were diffed byte for byte against `examples/mobile/src/rum.ts` and `examples/mobile/app.config.ts`; both demo apps typecheck after the port-default fix.
