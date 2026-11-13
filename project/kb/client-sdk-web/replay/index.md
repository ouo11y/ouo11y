# Web replay

| File | Question it answers |
|---|---|
| [web-replay-formats.md](web-replay-formats.md) | What exactly is in a `rrweb/2` chunk body (`replay.mode: "structure/dom"`), how does a reader decode a stream, and how did the paused pixel recorder (`ouo.frames/1`) make a frame? |
| [rrweb-events-before-the-first-snapshot.md](rrweb-events-before-the-first-snapshot.md) | Why did chunk 0 of a stream hold no snapshot when the SDK started before `load`, and what rule keeps the first chunk a keyframe? |
