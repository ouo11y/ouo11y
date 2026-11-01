# First-party endpoint for the browser SDK

Ad blockers and privacy extensions block requests to known telemetry hosts and paths. A user running one sends nothing, so their sessions are missing from the health numbers and their errors are invisible. The fix is to serve the collector from the site's own origin. The browser then sees an ordinary same-origin request.

```ts
import { initRUM } from "@ouo11y/browser";

initRUM({
  endpoint: "/otel", // relative: a route on the page's own origin
  projectId: "web-store",
  projectToken: "pt_...",
  service: { name: "web-store", version: "1.4.2", environment: "production" },
});
```

With a relative `endpoint` the SDK resolves it against the page and posts to:

| SDK request | Path on your origin | Proxy to |
|---|---|---|
| OTLP traces | `/otel/v1/traces` | collector OTLP/HTTP receiver, port 4318, `/v1/traces` |
| OTLP logs (events) | `/otel/v1/logs` | collector OTLP/HTTP receiver, port 4318, `/v1/logs` |
| replay chunks | `/otel/v1/replay/chunks` | collector replay receiver, port 4319, `/v1/replay/chunks` |

Any prefix works (`/otel` is an example; something app-specific like `/_t` is less likely to be on a list). `replayEndpoint` can stay unset: when `endpoint` is not on port 4318 the SDK sends replay to the same base, so the proxy splits `/v1/replay/*` from the rest.

## What the proxy must do

- Strip the prefix and forward to the right receiver: `/otel/v1/replay/*` to port 4319, everything else under `/otel/` to port 4318. Put the replay rule first where rules match in order.
- Pass the body and its headers through untouched: `Authorization` (the SDK still sends the project credential), `Content-Type`, and `Content-Encoding: gzip` (the SDK compresses bodies of 1 KB or more; the collector decompresses them). Do not decompress or re-encode.
- Allow bodies up to 8 MB (the replay receiver's limit; chunks are 256 KB by default).
- Pass `429` and `503` answers and their `Retry-After` header back unchanged: the SDK retries on them and waits as asked.
- Answer `502`, `503` or `504` when the collector cannot be reached (down, restarting, timed out), never `500`. The SDK retries network errors, `429`, `502`, `503` and `504` and keeps them for later; any other answer, `500` included, means the request will never be accepted, so it is dropped. nginx and Caddy answer `502` and `504` on their own; the Next.js rewrite and the Vite dev proxy answer `500` (see their sections).
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

When the collector cannot be reached, the rewrite answers `500 Internal Server Error`, which the SDK treats as final: what the pages send during a collector restart or outage is dropped instead of retried and kept for later. If that matters, put nginx or Caddy in front of the collector route (they answer `502`), or proxy it with a route handler that answers `502` when its request to the collector fails.

## Vite dev server

For local development the same route keeps dev and production configs alike:

```ts
// vite.config.ts
import { defineConfig, type ProxyOptions } from "vite";

// Vite answers 500 when the target cannot be reached, which the SDK treats as final (the request
// is dropped). Answer 502 instead, so it is retried and kept for later; this handler runs before
// Vite's own, which then leaves the response alone.
const answer502: ProxyOptions["configure"] = (proxy) => {
  proxy.on("error", (_err, _req, res) => {
    if ("writeHead" in res && !res.headersSent) res.writeHead(502).end();
  });
};

export default defineConfig({
  server: {
    proxy: {
      "/otel/v1/replay": { target: "http://localhost:4319", rewrite: (p) => p.replace(/^\/otel/, ""), configure: answer502 },
      "/otel": { target: "http://localhost:4318", rewrite: (p) => p.replace(/^\/otel/, ""), configure: answer502 },
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
