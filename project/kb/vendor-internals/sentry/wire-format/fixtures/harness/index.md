# Request harness

Python 3.14 scripts that built and sent the requests recorded in [../relay-responses/](../relay-responses/index.md). Standard library plus `brotli` (installed only in a scratch venv to test `Content-Encoding: br`). The public key is a command-line argument and is never written unredacted.

| Path | What it is |
|---|---|
| [harness.py](harness.py) | All framing, compression, auth, item-type, replay, size-limit, endpoint and OTLP cases (`python -I harness.py <out_dir> <public_key>`) |
| [extra.py](extra.py) | Item combinations (`event` + `replay_event`, `event` + `transaction`), wrong project path, session edge cases |
| [rl.py](rl.py) | Rate-limit probe, run while the project key had `rateLimit {window: 60, count: 1}` |
| [rl2.py](rl2.py) | Mixed envelope (limited error + session) under the same rate limit |
