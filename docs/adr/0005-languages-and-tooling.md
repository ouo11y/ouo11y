# ADR-0005 Languages and tooling

Status: accepted (2026-10-06)

## Decision

- **Go 1.26** for `services/rum-api` and `examples/backend`. Standard library `net/http`, OTel Go SDK with `otelhttp`. One Go module per directory.
- **TypeScript** (strict, ESM) for `sdk/browser`, `sdk/react-native`, `plugins/ouo-rum-app`, `examples/web`, `examples/mobile`. npm workspaces at the repo root, Node 24, Vitest for unit tests.
- **Web demo**: React 18 + Vite. **Mobile demo**: Expo (managed workflow) so it runs on the iOS Simulator without native tooling changes.
- **Grafana plugin**: scaffolded with `@grafana/create-plugin`, frontend-only app plugin with a `routes` proxy to rum-api.
- **Local stack**: Docker Compose with the official `grafana/grafana`, `grafana/loki`, `grafana/tempo`, `grafana/mimir` and `otel/opentelemetry-collector-contrib` images.

## Consequences

- Two languages total. Agents working on services do not need Node, agents working on apps do not need Go, except for the demo backend.
- Expo adds a dependency but removes Xcode project maintenance from the MVP.
