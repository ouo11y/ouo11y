# Client SDK: React Native

How `@ouo11y/react-native` is built while it moves to the client SDK spec ([ADR-0021](../../../docs/adr/0021-react-native-sdk-keep-and-extend.md)). Started 2026-11-12 with step A.

| Path | Question it answers |
|---|---|
| [step-a-layers.md](step-a-layers.md) | Which layers did step A add, where does each live, and what did building them teach us (guard, fault injection, no OTel globals, the Hermes rejection tracker, what is still open)? |
| [npm-in-worktrees.md](npm-in-worktrees.md) | Why does `npm` exit with "call config.load() before reading values" in a worktree, and how to run it anyway? |
