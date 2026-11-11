# 2026-11-10 sentry-browser (Step 6 vendor research)

Agent: `sentry-browser`. Scope: the Sentry JavaScript browser SDK (`@sentry/browser`, `@sentry/react`) at **11.11.0**, compared with 10.78.0.

## What was done

- Read the SDK source at tags 11.11.0 and 10.78.0 (three helper agents wrote the code-reading drafts: configuration, architecture + sampling + reliability, replay; I checked them against the captures and added "Observed" sections).
- Built `examples/sentry-web/` (Vite 7.2.2 + React 19.2.0 + `@sentry/react` 11.11.0) with one button per feature and URL switches for buffer replay, canvas, static transactions, `beforeSend` drops, `sampleRate: 0`, offline transport and alternate endpoints.
- Captured 103 requests with `sentrytap` (forward to self-hosted Sentry 26.10.0, project `step6-browser`; and a 429 sink behind a CORS shim), decoded them, exported 25 redacted fixtures.
- Measured tree-shaken bundle sizes per feature set (`npm run size`) and the 11.11.0 CDN bundles.
- Wrote `project/kb/vendor-internals/sentry/browser-sdk/` (index, explainer HTML, architecture, configuration, sampling, reliability, replay-browser, wire-capture, footprint, fixtures) and the shared note `step6-sentry-browser-captures.md` with every replay, event and trace id.

## Verified and how

- Wire format, envelope headers, item types, response bodies, CORS behaviour, client-report reasons, rate-limit handling, offline queue, buffer-to-session conversion, tab-close loss: observed in sentrytap captures (fixtures listed in `fixtures/index.md`).
- Ingest: the events and the three replays were read back from the self-hosted API (`/projects/sentry/step6-browser/events/`, `/replays/<id>/`).
- Replay timestamp units: censused over every decoded recording; confirms the read-api agent's mixed-unit finding.
- Bundle sizes: Vite builds, gzip -9 and brotli q11 via Node zlib.

## Not verified

- LCP and CLS standalone spans (the browser pane was hidden, so no LCP entry existed), canvas replay events, the feedback widget UI (screenshot path exercised via `captureFeedback`), the CDN loader script, `tunnel` (envelope `dsn` header), keepalive behaviour at real tab close in other browsers, 10.78.0 bundle sizes.
- `visibilitychange` was simulated by overriding `document.visibilityState`; real hides only happened through navigations.

## What the next agent must know

- v11 defaults change what a receiver sees: span v2 containers instead of transactions, `infer_ip:auto`, logs and metrics always on, synthetic stacks on messages (server titled a message event with the minified function name).
- A browser-facing receiver must send `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers` on every status or the SDK ignores rate limits. `sentrytap -sink` sends no CORS headers.
- The DSN public key can appear inside compressed replay recordings (network bodies); redact after decompressing.
- Process notes: a hook blocked writes to the old `step6-sentry-browser` worktree, so everything was staged in the scratchpad and copied into `nice-bun-f8114a`. Nothing was committed by this agent. All processes this agent started (sentrytap PIDs 42986, 42987; CORS shim 46019; vite preview 43186/43213) were stopped by PID.

## Dependencies added (demo only, `examples/sentry-web`, not a workspace)

- `@sentry/browser` 11.11.0, `@sentry/react` 11.11.0: the SDK under study.
- `react` / `react-dom` 19.2.0: exercise `@sentry/react` (ErrorBoundary, `reactErrorHandler`).
- `vite` 7.2.2, `@vitejs/plugin-react` 5.1.0: bundler for the demo and for tree-shaken size measurements.
