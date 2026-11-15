# What the SDK does when the bridge fails, and what it loses

Written 2026-11-15 by `sentry-demo` (session sentry-mirror) for the switch of a pilot app's production DSN to the bridge. Sources: the receiver code at this date, [mobile SDK reliability](../../vendor-internals/sentry/mobile-sdks/index.md) and [Relay auth and endpoints](../../vendor-internals/sentry/wire-format/auth-and-endpoints.md) from the 2026-11-10 research.

## The rule that decides everything

Mobile Sentry SDKs (sentry-cocoa, sentry-java, React Native over both) **delete an envelope on any HTTP 4xx or 5xx** and keep it only on a network error (connection refused, reset, timeout). The disk cache keeps **30 envelopes** by file count; older ones are deleted when it is full. So:

| What the SDK gets | What happens to the envelope |
|---|---|
| Sentry's own answer, passed through | Exactly what would happen without the bridge |
| Aborted connection (bridge: upstream unreachable) | Cached, retried later: no loss while the outage stays within 30 envelopes per device |
| Connection refused (bridge process down, nothing in front) | Same: cached and retried |
| `403` from the bridge (key or project not in the table, no `passthrough_upstream`) | **Deleted.** Production loses it |
| `502` / `503` from a load balancer in front of a down bridge | **Deleted.** Production loses it |
| `413` from the bridge (body above `max_request_body_size`) | Deleted, as Sentry would (Sentry's own limit is lower than the 100 MiB default) |

Two consequences for a cut-over:

1. `passthrough_upstream` must be set to the production ingest host: a table miss then costs nothing.
2. Whatever sits in front of the bridge must not turn "bridge down" into a `5xx`. Either clients reach the bridge directly (refused connection, retried), or the proxy falls back to Sentry directly (`error_page 502 503 504 = @sentry`, [deployment guide](../../../../docs/sentry-bridge-deployment.md#putting-a-production-app-behind-the-bridge)). A Kubernetes `Recreate` rollout without such a fallback answers `503` from the ingress for the seconds the pod is gone.

## Relay checks that matter for a mirror

- The envelope header `dsn`, when present, must carry the same project id and public key as the request, else Relay answers `400 project id header mismatch` / `public key header mismatch`. A mirror that rewrites credentials must therefore rewrite `dsn` too; the bridge does (spec section 2b). Mobile SDKs send no `dsn`; JS SDKs send it with `tunnel`.
- Two auth sources in one request (header and query) are `401` even with the same key: passed through unchanged, so the SDK sees it as it would without the bridge.

## Things that are not risks

- Header case: Go writes canonical header names (`X-Sentry-Auth`); HTTP header names are case-insensitive and Relay does not care.
- `Content-Length` and chunked uploads: the bridge buffers the body and sends it with a length; the bytes are identical.
- `br` or `zstd` bodies: forwarded unchanged (only ouo's translation skips them).
- Translation, Loki, Tempo, rum-api or Muninn being slow or down: forwarding does not wait for them; the translation queue drops (counted) when full.

## Risks that stay

- The bridge is one more hop and one more process in front of production. Its own bugs can still lose data where they produce a 4xx/5xx; a translator panic no longer can (recovered since ADR-0028).
- Session state is in one process's memory: a restart loses held replay segments and session matching for the ouo copy, never for Sentry.
- The user IP Sentry records comes from `X-Forwarded-For`; check one event after the switch.
