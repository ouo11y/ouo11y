# Web replay formats

What the web SDK puts in the body of an `ouo.replay.chunk` record (spec section 11.3 has the attributes). Both formats are streams of self-delimiting units, so for either one:

> the payload of a segment = the decompressed bodies of its chunks, concatenated in `ouo.replay.sequence` order.

A chunk may end in the middle of a unit (a large unit is split across chunks, never truncated), so a reader must concatenate before it parses. Each body decompresses alone. `ouo.replay.encoding` is per chunk: `gzip` normally, `none` for the chunk a page closes with (nothing can be awaited then) and for every `ouo.frames/1` chunk (images are already compressed).

## `rrweb/2` (structure)

- Unit: one rrweb 2 event as JSON, followed by `\n` (UTF-8). So the payload is newline-delimited JSON.
- A segment starts with a `Meta` event (type 4) and the `FullSnapshot` (type 2) after it. `ouo.replay.keyframe=true` marks the chunk that begins with the `Meta` event.
- Masking, done on the device before the event is encoded: text nodes are `***` (whitespace-only text is kept, it is layout); form values are `***`; `title`, `alt`, `placeholder`, `aria-label` and similar attributes are `***`; checked and selected states are dropped where the value is masked; `img`, `picture`, `video`, `audio`, `canvas`, `embed`, `object` are recorded as empty boxes of the same size; `href`, `src`, `action` and the page URL are sanitised like every other URL.
- `data-ouo-unmask` on an element records its subtree as written; `data-ouo-mask` inside it masks again; `data-ouo-block` blocks. Fields with `type=password`, an `autocomplete` of `current-password`, `new-password`, `one-time-code` or `cc-*`, or a name or id that looks like a secret, are masked whatever the page says.

A reader feeds the events to rrweb's replayer unchanged.

## `ouo.frames/1` (pixel), under development

Paused (founder, 2026-11-12: not needed now). The web SDK does not emit this format: `replay.format: "pixel"` records `rrweb/2` instead. What follows describes the adapter as it stands in `sdk/browser/src/replay/pixel.ts`, for when the work resumes.

- Unit: `u32 header length | header (UTF-8 JSON) | u32 payload length | payload`, lengths big endian.
- `{"k":"frame","t":<ms>,"w":<px>,"h":<px>,"vw":<css px>,"vh":<css px>,"sx":<scroll x>,"sy":<scroll y>,"dpr":<n>,"mime":"image/webp"|"image/jpeg","masked":true}` with the image as payload. Every frame is a full image of the viewport, so every frame is a keyframe and every chunk decodes alone.
- `{"k":"pointer","t":<ms>,"x":<css px>,"y":<css px>,"p":"down"}` with no payload: where the pointer went down, in viewport coordinates. A reader scales by `w / vw`.
- A reader draws each frame at its `t` and keeps it until the next one. A page that does not change sends no frames.

`decodeFrames` in `sdk/browser/src/replay/pixel.ts` is a reference decoder.

### How a frame is made

1. A MutationObserver on the document, plus scroll, resize and input, mark the page dirty. A capture runs at most `pixelMaxFps` times a second, never while the page is hidden, and waits ten times as long as the last capture took (so a slow page is captured less often).
2. The page is cloned node by node into a detached document. While cloning: text outside `data-ouo-unmask` becomes `*` per character (layout kept, words gone); form values, `value`, `placeholder`, `title`, `alt` are left out; `script`, `link`, event handlers and every `src` / `href` are left out; images, video, canvas and frames become grey boxes of the size the live element has.
3. The CSS of every same-origin stylesheet is put in one `<style>`, with `@import` and every non-`data:` `url()` removed, so the frame loads nothing from the network.
4. The clone is serialised to XHTML, wrapped in an SVG `foreignObject` whose `viewBox` is the viewport at the current scroll position, loaded as a `data:` URL into an image, drawn to a canvas scaled so its longest side is at most `pixelMaxSide`, and encoded as WebP (JPEG where the browser cannot encode WebP).
5. If the serialised frame equals the last one sent, nothing is sent.

The live page is never drawn, only the masked clone, so the "masking race" of screenshot-based recorders does not exist here: there is no moment at which an unmasked pixel could be captured. A frame whose cloning or drawing throws is dropped and counted (`ouo.replay.frame`, `mask_failed`).

### What was measured before the pause

On the e2e page (`sdk/browser/e2e/pages/app.html`, 1280x720 viewport), in Playwright 1.64.1:

| Engine | Works | Image | Frame size |
|---|---|---|---|
| Chromium | yes | WebP | about 6 KB |
| Firefox | yes | WebP | about 6 KB |
| WebKit | yes | JPEG | about 20 KB |

A `data:` URL is needed: Chromium taints a canvas that drew an SVG `foreignObject` from a `blob:` URL. Under a Content-Security-Policy the page needs `img-src data:`.

### Limits

Styles from cross-origin stylesheets that the page cannot read, web fonts (the fallback font is drawn), the scroll position of inner scroll containers, and anything painted outside the DOM (canvas, video, plugins) are not reproduced. Pages above 20 000 nodes are not captured (the frame is dropped and counted). The cost grows with the size of the DOM: cloning and serialising run on the main thread. The CPU and memory cost on a large page was not measured.
