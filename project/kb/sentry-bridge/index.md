# Sentry bridge

Running a production app's unchanged Sentry SDK through the collector's `ouosentry` receiver ([spec](../../../docs/specs/sentry-bridge.md), [ADR-0028](../../../docs/adr/0028-sentry-bridge-mirrors-and-passthrough.md)): what can go wrong for production Sentry, and what the bridge costs. How Sentry itself works is in [vendor-internals/sentry/](../vendor-internals/sentry/index.md).

| Path | What it is |
|---|---|
| [production/](production/index.md) | Putting a production DSN behind the bridge: failure modes and what the SDK does in each, the mirror fan-out, measured overhead |
