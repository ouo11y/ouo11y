# First-party endpoint for the browser SDK

Ad blockers and privacy extensions block requests to known telemetry hosts and paths. A user running one sends nothing, so their sessions are missing from the health numbers and their errors are invisible. The fix is to serve the collector from the site's own origin. The browser then sees an ordinary same-origin request.

```ts
import { init } from "@ouo11y/browser";

init({
  endpoint: "/otel", // relative: a route on the page's own origin
  projectId: "web-store",
  projectToken: "pt_...",
  serviceName: "web-store",
  serviceVersion: "1.4.2",
  environment: "production",
});
```

With a relative `endpoint` the SDK resolves it against the page and posts to:

| SDK request | Path on your origin | Proxy to |
|---|---|---|
| OTLP traces | `/otel/v1/traces` | collector OTLP/HTTP receiver, port 4318, `/v1/traces` |
| OTLP logs (events, and replay chunks as `ouo.replay.chunk` records) | `/otel/v1/logs` | collector OTLP/HTTP receiver, port 4318, `/v1/logs` |

Any prefix works (`/otel` is an example; something app-specific like `/_t` is less likely to be on a list). From `@ouo11y/browser` 0.4 replay travels on `/v1/logs` as OTLP protobuf, so the browser SDK needs no second route; the `/v1/replay/*` rules in the examples below are only for the mobile SDKs and older browser SDK versions, which post replay to the collector's replay receiver on port 4319.

## What the proxy must do

- Strip the prefix and forward everything under `/otel/` to port 4318 (and, for SDKs that still use the replay receiver, `/otel/v1/replay/*` to port 4319, with that rule first where rules match in order).
- Pass the body and its headers through untouched: `Authorization` (the SDK still sends the project credential), `Content-Type` (`application/json` for telemetry, `application/x-protobuf` for replay chunks), and `Content-Encoding: gzip` (the SDK compresses bodies of 1 KB or more; the collector decompresses them). Do not decompress or re-encode.
- Allow bodies up to 8 MB (the replay receiver's limit; chunks are 256 KB by default).
- Pass `429` and `503` answers and their `Retry-After` header back unchanged: the SDK retries on them and waits as asked.
- Add `X-Forwarded-For` and run the collector with `OUO_RATELIMIT_CLIENT_KEY=x_forwarded_for`. Otherwise every user shares the proxy's address and one per-client rate-limit bucket.

CORS does not apply to same-origin requests. The collector's `OUO_ALLOWED_ORIGINS` only matters for pages that still post to it directly.

## nginx

```nginx
upstream ouo_otlp   { server ouo-collector:4318; }
upstream ouo_replay { server ouo-collector:4319; }

server {
    # ... your site ...

    # Replay chunks: the collector's replay receiver. The longer prefix wins over /otel/.
    location /otel/v1/replay/ {
        proxy_pass http://ouo_replay/v1/replay/;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 8m;
    }

    # OTLP/HTTP traces and logs.
    location /otel/ {
        proxy_pass http://ouo_otlp/;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 8m;
    }
}
```

`proxy_pass` with a URI replaces the matched `location` prefix, so `/otel/v1/traces` reaches the collector as `/v1/traces`.

## Caddy

```caddy
example.com {
    # ... your site ...

    # Replay chunks: drop /otel, keep /v1/replay/...
    handle /otel/v1/replay/* {
        uri strip_prefix /otel
        reverse_proxy ouo-collector:4319
    }

    # OTLP/HTTP traces and logs: handle_path strips /otel.
    handle_path /otel/* {
        reverse_proxy ouo-collector:4318
    }
}
```

Caddy tries `handle` blocks from the most specific path matcher down, so the replay block wins for `/otel/v1/replay/...`. `reverse_proxy` sets `X-Forwarded-For` itself.

## Next.js (rewrites)

```js
// next.config.js (or next.config.mjs with `export default`)
module.exports = {
  async rewrites() {
    const collector = process.env.OUO_COLLECTOR_HOST; // for example "ouo-collector.internal"
    return [
      // First match wins: replay before the catch-all.
      { source: "/otel/v1/replay/:path*", destination: `http://${collector}:4319/v1/replay/:path*` },
      { source: "/otel/:path*", destination: `http://${collector}:4318/:path*` },
    ];
  },
};
```

The rewrite proxies the request server-side, so the collector does not need to be reachable from the browser. On a hosting platform, check its limit on proxied request bodies against the replay chunk size (`replay.maxChunkBytes`, 256 KB by default).

## Vite dev server

For local development the same route keeps dev and production configs alike:

```ts
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      "/otel/v1/replay": { target: "http://localhost:4319", rewrite: (p) => p.replace(/^\/otel/, "") },
      "/otel": { target: "http://localhost:4318", rewrite: (p) => p.replace(/^\/otel/, "") },
    },
  },
});
```

## `sendBeacon` through the proxy

At page hide the SDK sends with `fetch(..., { keepalive: true })`, which carries `Authorization`. When the 64 KB keepalive budget is spent, the rest goes to the offline store and is sent on the next page load. `transport: { beacon: true }` adds a third option, `navigator.sendBeacon`, before the store. A beacon cannot set headers, so the collector would answer `401`. It only works when the proxy adds the credential for requests that arrive without one. The token is public (it ships in the page), so the proxy may hold it. nginx:

```nginx
map $http_authorization $ouo_authorization {
    ""      "Basic <base64 of projectId:projectToken>";
    default $http_authorization;
}
# in both locations above:
proxy_set_header Authorization $ouo_authorization;
```

## Checking it

- `examples/ouo-web/scripts/run.sh --first-party` builds the storefront with `VITE_OTLP_ENDPOINT=/otel` and serves it with `scripts/serve-first-party.mjs`, a small Node server that proxies `/otel` like the examples above. The journey and every verify check, trace continuity included, pass in Chromium, Firefox and WebKit (2026-10-24).
- `sdk/browser/e2e/delivery.spec.ts` ("first-party route") runs the SDK with `endpoint: "/otel"` against a same-origin proxy in the three engines.
- In the browser's network panel the SDK's requests go to your own origin, with no preflight.
