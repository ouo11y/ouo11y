# rrweb emits events before its first snapshot when it starts before `load`

Found 2026-11-13 in `@ouo11y/browser` 0.4.0 (reported by the Muninn end-to-end run, fixed in the engine).

## What rrweb does

`record()` in rrweb 2.x looks at `document.readyState` when it is called:

- `interactive` or `complete`: it takes the full snapshot at once. The first events are `Meta` (type 4) and `FullSnapshot` (type 2).
- `loading`: it waits. It emits `DomContentLoaded` (type 0) when that event fires, `Load` (type 1) at `load`, and only then takes the snapshot (`recordAfter` is `load` by default). The first events are 0, 1, 4, 2.

Which case a page is in depends on how it loads the SDK:

- A `<script type="module">` (how our e2e page `app.html` loads it) runs after parsing, so `readyState` is `interactive`: never the second case.
- A classic `<script>` bundle in the body (the Muninn e2e page, most bundled apps whose parser is still busy, a slow blocking script after the SDK's) starts the SDK while `readyState` is `loading`: the second case.
- While a parser-blocking script is pending, Firefox holds a dynamic `import()` made by a classic script, so the test page (`import()` then a slow blocking script) reaches the second case in Chromium and WebKit only. A document that is only slow to arrive reaches it in Firefox too, but the reviewer measured that variant as flaky (2 of about 12 Firefox runs started replay after the hold).

## What went wrong

The engine took the first data of a stream as the start of chunk 0, whether it was a keyframe or not. With events 0 and 1 first, chunk 0 held only those two events with `ouo.replay.keyframe=false` as segment 0, and the `Meta` + `FullSnapshot` came in chunk 1 as segment 1. That breaks RPL-6 (the first chunk of a segment is a keyframe), and a reader that starts at chunk 0 has nothing to draw.

## The rule now

The engine discards data until the first keyframe of a stream (`needKeyframe` starts as `true` in `sdk/browser/src/replay/engine.ts`), the same rule it already applied after a loss (RPL-8). It is in the engine and not in the rrweb adapter, so it holds for any format. The two rrweb events lost carry no data; rrweb's `Replayer` does not need them.

## How to test it

`sdk/browser/e2e/pages/early.html` starts the SDK from a classic script and holds the parser with `late.js?delay=2000` (the e2e server delays any file with `?delay=`). The test in `e2e/replay.spec.ts` checks chunk 0, then gives its events alone to rrweb's `Replayer` (served by the e2e server at `/rrweb.js`) and looks at the DOM it builds.
