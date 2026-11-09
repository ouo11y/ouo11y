# RUM semantic conventions

Which OTel conventions exist for RUM signals, what to predict where they are silent, and which signals are events or spans. Step 2 of the post-MVP plan. Start with the signal table.

| File | Question it answers |
|---|---|
| [signals-table.html](signals-table.html) | For every client signal: event or span, name, OTel status, confidence? |
| [rules.md](rules.md) | Which sources and versions were read, how are names chosen, and when is a signal an event or a span? |
| [performance.md](performance.md) | How are web vitals and mobile performance modelled? |
| [errors.md](errors.md) | How are errors, crashes and ANRs modelled? |
| [interactions.md](interactions.md) | How are clicks, taps, coordinates, and rage or dead clicks modelled? |
| [navigation.md](navigation.md) | How are page loads, route changes and screens modelled? |
| [sessions.md](sessions.md) | What do `session.id` and session events specify? |
| [replay.md](replay.md) | How should replay be modelled when OTel has no convention? |
| [propagation-and-resources.md](propagation-and-resources.md) | How do `session.id` and `traceparent` propagate, and what belongs on the resource? |
| [questions-for-step-3.md](questions-for-step-3.md) | What must the founder decide, and what does the SDK spec have to answer? |
