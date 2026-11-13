# Capturing what `@ouo11y/browser` sends in headless Chromium, without a stack

Learned 2026-11-13 while capturing a real exception record for the ADR-0022 demo (`project/agents/symbolication/prototype/demo/capture.mjs`).

- **Playwright routes are enough.** Answer the app's origin from the built `dist`, and every other origin (the OTLP endpoint, the demo backend) with an empty 200. No server and no port.
- **The SDK gzips its OTLP/JSON bodies.** `route.request().postData()` on a gzip body is not JSON, and a parse inside a `try` hides it: the capture reads zero records with no error. Use `postDataBuffer()` and `gunzipSync` when `content-encoding` is `gzip`.
- **The fulfilled answer needs CORS headers.** The OTLP endpoint is another origin and the request carries `Authorization`. Without `access-control-allow-origin` and `access-control-allow-headers` on the fulfilled response the SDK's requests fail.
- **Wait for the timed flush.** The SDK flushes every 5 s (`transport.flushIntervalMs`). Poll the captured records instead of leaving the page: requests sent with `keepalive` at page hide are not a reliable thing to wait for in a script that closes the browser next.
- **`ouo-sourcemaps inject` must run on the `dist` before the page loads**, or the record has no `ouo.exception.debug_ids`.
- **Vite's asset names change with the build environment.** `VITE_*` values are compiled in, so the main bundle's hash differs between builds with different endpoints. Take the file name from the `dist`, not from an earlier run.
