# 2026-10-18 Self-hosted Sentry as the bridge's upstream (N2), F4 side by side

## Done

- Installed getsentry/self-hosted 26.10.0 in `~/Desktop/personal/sentry-self-hosted` (outside the repo) as compose project `sentry-sbx`, `feature-complete`, telemetry off (`--no-report-self-hosted-issues`, `SENTRY_BEACON = False`). Login `admin@ouo.localhost` / testing567 (superuser, org owner); the first user `admin` could not sign in (the form wants an email) and was deleted. Project `sentry-demo` (id 2, react-native).
- Docker Desktop raised to 20 GB + 4 GB swap by the founder. Sentry uses 14.0 GiB idle, 13.2 GiB after the run.
- Sentry MCP: `@sentry/mcp-server` 0.42.0 in the **user-level** Claude config as `sentry-sbx` (founder's choice; `sentry` was taken by another host), read-only token (`org:read project:read team:read event:read`), `--skills=inspect`. It needs https for anything beyond `find_projects`, so:
- `deploy/envs`: the shared Traefik proxy got a websecure entrypoint and a file provider; `ouo-env proxy up` creates a local CA and a `*.ouo.localhost` certificate with openssl and routes `http(s)://sentry.ouo.localhost` to the self-hosted Sentry (`EXTERNAL` in `lib.mjs`). The env route for the collector's Sentry bridge is renamed `sentry` → `sentry-bridge`. Sentry's `system.url-prefix` is `https://sentry.ouo.localhost`.
- N2 run: ouo on the 0.2.0 images (compose project `ouo-sentry`, ports 33xx/43xx), app built from main with the DSN at `sentrytap` A, bridge upstream at `sentrytap` B in front of Sentry, real simulator taps.
- F4: the same unmasked session in Sentry's replay player and in the ouo plugin 0.6.0, with screenshots.

## Verified, and how

- `sentrytap compare`: 49/49 byte-identical, 0 problems; all 49 answers 200 with identical headers at A and B (apart from `Date`); no rate-limit headers, no 413, no auth errors.
- Sentry API (read token): 4 error events, 10 transactions, 2 replays (18 + 6 segments), sessions 1 crashed + 1 healthy, logs.
- `verify-bridge.py`: 19/21. Failures: 5 startup console/log records without a session, and `Running "main"` stored twice. Both come from the app logging before sentry-cocoa's session exists (rollout code); not upstream-related.
- MCP over stdio (`find_projects`, `get_replay_details` for replay 9aed74e9) with the token from the user config.
- `node --test deploy/envs/*.test.mjs` 12/12; `https://sentry.ouo.localhost/_health/` 200 with the CA, `http://grafana.ouo.localhost` and `http://grafana.sbx.ouo.localhost` still 200 after the proxy was recreated.
- F4 by looking at both players in the built-in browser (screenshots in the report).

Report: [sentry-self-hosted-n2-f4.html](../reports/sentry-self-hosted-n2-f4.html). Knowledge: `project/kb/sentry-self-hosted.md`.

## Left

- Founder: trust the proxy CA for the browser (`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.local/state/ouo-env/proxy/tls/ca.pem`); until then https://sentry.ouo.localhost warns (http works).
- Founder: F4 verdict.
- Bridge: attach `log` items that arrive before any session to the device's next session, and de-duplicate them with replay breadcrumbs; treat `captureMessage` with `level: info` as `sentry.message` even when it carries a synthetic exception. Plugin: preload neighbouring video segments (black frame on seek).
- Spec: the bridge copies every upstream response header, not only the four listed.
- A quota-limited Sentry (real `X-Sentry-Rate-Limits` / 429) is still untested.

## For the next agent

- Start: `cd ~/Desktop/personal/sentry-self-hosted && docker compose --env-file .env.custom up -d --wait`, then `deploy/envs/ouo-env proxy up`. Stop with `down` (never `-v`).
- The ouo stack of this run: `docker compose -p ouo-sentry --env-file ~/Desktop/personal/ouo-sentry-n2/ouo.env -f deploy/compose/compose.yaml -f deploy/compose/compose.images.yaml up -d`. Captures and the env file are in `~/Desktop/personal/ouo-sentry-n2/`.
- The demo needs `npm run -w sdk/react-native build` before `scripts/build-ios.sh` (`no such module 'OuoReplay'` otherwise).
- Leftover `sentrytap` processes from other sessions hold ports 4400 and 4411.

Dependencies added: none in the repo. On the Mac: Homebrew `bash` 5.3 (the Sentry installer needs bash ≥ 4.4).
