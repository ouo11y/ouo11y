# gzip on Muninn's read path: who undoes Content-Encoding

> Muninn serves a gzip chunk as stored, with `Content-Encoding: gzip` (spec MUN-34). Which clients and proxies silently decompress it, and what does that break?

Found on 2026-11-13 while writing `tests/e2e/muninn/run.mjs` against an ouo-env stack (Traefik v3.7.13 in front of Muninn). Verified by fetching one chunk with and without the header.

| Client or hop | What happens | Effect |
|---|---|---|
| Node `fetch` (undici, Node 24) | Decompresses any `Content-Encoding: gzip` response, whatever `Accept-Encoding` the request sent | The body is the NDJSON, not the stored bytes; its SHA-256 differs from the `ETag` |
| Go `http.Transport` (default `DisableCompression: false`) | When the request has **no** `Accept-Encoding`, the transport adds `gzip`, then gunzips the answer itself and drops `Content-Encoding` and `Content-Length` | Same: decompressed body, hash mismatch. Sending `Accept-Encoding: gzip` explicitly turns it off |
| Traefik (Go reverse proxy) | Behaves as the Go transport above: `curl` without `--compressed` got the decompressed body and no `Content-Encoding` through `muninn.<env>.ouo.localhost` | Seen only through the proxy; Muninn itself sent gzip |
| `curl --compressed`, Node `http.get` with `Accept-Encoding: gzip` | Raw bytes as stored | Hash matches |

## What to do

- Any reader that checks the hash or passes the chunk to a player that expects the stored form sends `Accept-Encoding: gzip` and reads the raw body (Node: `http.get`, not `fetch`).
- The BFF in `ouo-go` is a Go client: set `Accept-Encoding: gzip` on chunk requests or a `Transport` with `DisableCompression: true`, and gunzip itself where it needs the events.
- Muninn needs no change: it never decompresses and never looks at `Accept-Encoding` on the chunk route.
