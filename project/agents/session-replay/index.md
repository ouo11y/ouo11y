# session-replay

Teaches how session replay works inside, per platform, from source at pinned tags, and gathers the evidence for how ouo records mobile replay.

- Owns: `project/kb/session-replay/` and the proposed `docs/adr/0018-borrow-the-replay-recorder.md`.
- Side sessions it started: a spike porting Sentry's iOS recorder core into the ouo SDK (branch `sentry-recorder-ios`), a masking leak experiment (branch `masking-experiment`), and the replay-school site. Each writes its own summary here.
- Does not change product code in this folder's PR, and decides nothing: ADR-0018 is a proposal.

| File | Content |
|---|---|
| [tracker.md](tracker.md) | What was done and what is open |
| [summaries/](summaries/index.md) | Dated run summaries |
| [The kb entries](../../kb/session-replay/index.md) | Session replay internals, topics 1–7 |
