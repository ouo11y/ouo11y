# Scripts

Research scripts only, Python 3 standard library, no dependencies. Run them with `python3 -I`. Tokens come from environment variables and are never written to disk by the scripts (except `mint_tokens`, which prints them once).

| Path | What it is |
|---|---|
| [muninn_pull.py](muninn_pull.py) | Lists every replay (following `Link` cursors), downloads a web and a mobile replay through the list and per-segment endpoints and the video endpoint, checks completeness, reassembles one time-ordered rrweb array. Read-only |
| [ingest_latency_probe.py](ingest_latency_probe.py) | Sends one error, transaction, log, session and 2-segment replay through a DSN, then polls 13 read paths and prints seconds until each shows the data. **Writes data** into the project you point it at |
| [scope_matrix.py](scope_matrix.py) | Calls 30 GET endpoints with every token in a JSON file and prints the status matrix. Read-only |
| [capture_fixtures.py](capture_fixtures.py) | Saves redacted sample responses and headers into `../fixtures/`. Read-only |
| [mint_tokens.sentry-exec.py](mint_tokens.sentry-exec.py) | Self-hosted only, runs with `sentry exec` in the web container: creates narrow-scope user and org auth tokens |
| [revoke_tokens.sentry-exec.py](revoke_tokens.sentry-exec.py) | Self-hosted only: deletes or deactivates the tokens made above (name prefix `step6-read-api`) |
