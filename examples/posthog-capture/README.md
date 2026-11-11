# posthog-capture

Step 6 vendor research harness: run posthog-js against a local endpoint and save every request it makes, decoded. No PostHog account and no PostHog server are needed.

- `posthog-js` **1.447.6** from npm. The page loads `node_modules/posthog-js/dist/array.js`, and the server serves the lazy extensions (`/static/<version>/<kind>.js`) from the same `dist/`. Nothing comes from a CDN.
- `server.mjs` is a Node 24 HTTP server with no dependencies. It listens on `127.0.0.1:4570` and:
  - serves the demo page and the dist files
  - returns 404 for `/array/<token>/config.js` and a mock remote config for `/array/<token>/config`, which turns on replay with network headers and bodies and console, exception autocapture, web vitals, dead clicks, heatmaps and console logs
  - mocks `/flags/?v=2`
  - accepts `/e/`, `/i/v0/e/`, `/s/`, `/batch/` and `/i/v1/logs`
  - saves each request to `captures/NNNN-<method>-<path>.json` with headers, query, decode steps and the decoded body. The decoding reverses gzip, base64 form `data=`, and the per-event `cv: "2024-10"` gzip inside `$snapshot_data`
  - `/__ctl?failStatus=500&failCount=3` forces failures and `/__ctl?quotaLimited=true` simulates quota limiting, for the reliability runs
  - `RAW=1` keeps the undecoded bytes too, and `OUT=<dir>` writes captures elsewhere
- `drive.mjs` starts headless Chrome on DevTools port 4579 and plays a scripted session with real mouse and key input: clicks, a rage click, typing into text, password and allowlisted fields, a form submit, fetch 200 and 500, console logs, a thrown error, an unhandled rejection, manual capture, identify and captureException, 200 DOM inserts, pushState and scroll. It then navigates away so the unload beacons fire. It kills only the Chrome PID it started.
  - `NETLOG=1` logs the requests the page makes.
  - `VERBOSE=1` prints console output.
  - `OFFLINE_TEST=1` adds a 5 s offline period.

## Run

```bash
cd examples/posthog-capture
npm install --no-workspaces      # posthog-js 1.447.6 only
node server.mjs &                # note the pid it prints
node drive.mjs                   # or open http://posthog-capture.localhost:4570/ in a browser
ls captures/
kill <server pid>
```

## Gotchas found while building it

- **Bot filter.** posthog-js drops all events when the user agent looks like a bot, and `HeadlessChrome` counts as one. `drive.mjs` overrides the UA through `Network.setUserAgentOverride`.
- **Localhost.** The replay network plugin is off when `location.hostname` is exactly `localhost` or `127.0.0.1`. Use `posthog-capture.localhost`, which Chrome resolves to 127.0.0.1.
- **No compression flag.** gzip bodies arrive as `Content-Type: text/plain` with no `compression` query param and no `Content-Encoding`. Sniff the gzip magic bytes (`1f 8b`).
- **Replay body shape.** It is a bare JSON array of `$snapshot` events, not `{api_key, batch}`.

Findings and fixtures are in [project/kb/vendor-internals/posthog/](../../project/kb/vendor-internals/posthog/index.md).
