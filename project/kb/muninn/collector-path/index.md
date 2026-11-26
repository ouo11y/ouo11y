# Collector to Muninn

How `ouo.replay.chunk` travels from an SDK to Muninn, and how a player reads it back. Written 2026-11-11 for ADR-0019. Start with the explainer.

| File | Question it answers |
|---|---|
| [collector-to-muninn-explainer.html](collector-to-muninn-explainer.html) | What does the whole path look like, who answers 2xx when, what happens when a part is down, and what must the founder confirm? |
| [today-and-target.md](today-and-target.md) | What does the MVP replay path on `main` look like, and how does the target differ hop by hop? (The MVP path is removed, not evolved) |
| [durable-handoff.md](durable-handoff.md) | Can stock Collector components give "2xx only after fsync"? What was checked in the v0.160 source (including the `set(body, nil)` trap), what still needs a test, and a sketch of the new configuration |
| [contrib-collector-for-muninn.md](contrib-collector-for-muninn.md) | Can the Muninn route run on the stock contrib Collector 0.160.0? Yes, with `basicauth` for `ouoauth` and no rate limiter; the queue volume's owner trap and its fix (2026-11-15) |
