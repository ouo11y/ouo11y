# 2026-11-13: the first chunk of a replay stream is a keyframe

Fix for `@ouo11y/browser` 0.4.0, replay mode `structure/dom`. Reported by the Muninn end-to-end run; confirmed and fixed here. Not merged, not released: the founder does both.

## Root cause

rrweb's `record()` called while `document.readyState` is `loading` emits `DomContentLoaded` (type 0) and `Load` (type 1) and takes its first snapshot only after `load`. The engine started chunk 0 with whatever data came first, so chunk 0 held those two events with `keyframe=false`, and the `Meta` + `FullSnapshot` arrived as chunk 1, segment 1 (RPL-6 broken). It shows only when the SDK starts before the page finished loading (a classic script bundle); the existing e2e page loads it as a module, after parsing, which is why no test saw it. Details: [kb entry](../../../kb/client-sdk-web/replay/rrweb-events-before-the-first-snapshot.md).

The report was right about the symptom. The cause is the start time of the SDK relative to `load`, not the chunk cutting.

## Before and after

Captured in real browsers with the page `sdk/browser/e2e/pages/early.html` (SDK started while the document loads), one click, chunks as the collector stub received them.

Before (0.4.0), Chromium and WebKit:

```
seq=0 segment=0 keyframe=false rrweb types=[0,1]
seq=1 segment=1 keyframe=true  rrweb types=[4,2,3,3,3,3,3,3]
```

Before, Firefox (it runs the page's dynamic `import()` after parsing, so the SDK started later): `seq=0 segment=0 keyframe=true rrweb types=[4,2,3,...]`.

After, Chromium, Firefox and WebKit:

```
seq=0 segment=0 keyframe=true rrweb types=[4,2,3,3,3,3,3,3]
```

## The fix

One line in `sdk/browser/src/replay/engine.ts`: `needKeyframe` starts as `true`. The engine already discards data until a keyframe after a loss (RPL-8); it now does the same at the start of a stream, in session and buffer mode, for any format. No option added. Later keyframes (interval, visibility, after a loss) were already marked: the adapter flags rrweb's `Meta` event and the engine cuts a new chunk there.

## Tests

- Unit (`test/replay.test.ts`): a stub adapter that emits data before its first keyframe, in session and buffer mode: chunk 0 is `K0...`, `keyframe=true`, segment 0, stream `complete`.
- Real browser (`e2e/replay.spec.ts`, page `early.html`): chunk 0 starts with types 4, 2 and is a keyframe, all chunks are segment 0, and rrweb's `Replayer` given the events of chunk 0 alone builds the page (the unmasked heading is there, the button is there, the masked name is not). It failed in Chromium and WebKit before the fix.
- e2e server: `?delay=<ms>` on a page file, and `/rrweb.js` (rrweb's own build, for the `Replayer`).

## Verified, and how

- `npm run -w sdk/browser typecheck`: clean. `npm test`: 191 passed (9 files).
- `npm run build`, `size:check` (engine 7.3 KB of 8.0, index 42.1 of 42.5, structure 55.7 of 58.0), `compat:check`: ok.
- `npm run test:e2e` (Chromium, Firefox, WebKit) on port 4380: the existing 54 cases passed (buffer mode, page close, recovery by a later page, faults, CSP, locks); the new case then passed in the three engines after its wait was corrected.
- `lychee --offline`: clean.

## Left, for whoever is next

- `collector down: chunks wait in IndexedDB...` (`e2e/replay.spec.ts`) failed once in Firefox and passed 8 of 8 on repeat: the test sets the collector fault after the page is ready, so a first chunk can leave before it. Not caused by this change, not touched here. CI retries once.
- If masking the `Meta` event or the `FullSnapshot` itself throws, the adapter drops that one event and the other half of the keyframe still goes out. Not seen in practice; not changed here.
- No env was started. No dependency added.
