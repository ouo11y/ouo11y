# Replay privacy: mask all text, allow-list, never-record routes and screens

Answers: how `@ouo11y/browser` masks all text with rrweb 2.1.7 without a fork, what rrweb does
not mask, why stopping on a route change drops the new page, and how the React Native SDK hides a
screen (ADR-0003 revision 2026-11-03, ADR-0006 revision 3; P1 for the client JUHI, 2026-11-03).

## rrweb hooks that work

- **Mask all text with an allow-list**: `maskTextSelector: "*"` plus `maskTextFn(text, el)`.
  rrweb's `needMaskingText` does `el.closest(maskTextSelector)`, which `*` always matches, so
  every text node (snapshot `serializeTextNode`, mutation adds, `characterData` changes) goes to
  `maskTextFn` with its parent element (`closestElementOfNode` for text changes). The function
  decides with `closest(".ouo-mask,…")` then `closest(".ouo-unmask,…")`. `maskTextClass` hits
  the same function, so the function must re-check the mask classes itself. `<style>` and
  `<script>` text never reaches it.
- **rrweb masks no attributes** (`transformAttribute` only absolutifies URLs; there is no
  `maskAttributeFn` upstream, it is in Sentry's fork). `title`, `alt`, `placeholder`,
  `aria-label` and a submit button's `value` would go out verbatim. The SDK masks them in its emit
  callback: walk `FullSnapshot` `data.node` and mutation `adds[].node`, and mutation
  `attributes[]`, looking each id up with `record.mirror.getNode(id)` (filled before emit) to run
  the same `closest()` decision. `maskAllInputs: true` does not cover `input[type=button|submit|reset]`.
- `closest()` does not cross a shadow root: text inside one stays masked even under an
  `ouo-unmask` host (fail closed). An invalid host selector throws in `closest()`: catch and mask.
- Verified with the real recorder in jsdom (`sdk/browser/test/privacy.test.ts`) and in
  Chromium, Firefox and WebKit (`e2e/sdk.spec.ts`).

## Stop on route change drops the new page's DOM

rrweb's MutationObserver callback runs as a microtask; `record()`'s stop function disconnects the
observer and never calls `takeRecords()`. A router that renders the new page and calls
`pushState` in the same task (React Router, Next.js commits then `pushState` in an insertion
effect) therefore loses those records when the SDK stops synchronously inside its `pushState`
patch. Proven in jsdom (`privacy.integration.test.ts`) and three engines (e2e). A router that
renders in one task and changes the URL in a later one records that render.

A custom event can be pushed into the chunk stream without rrweb recording
(`{ type: 5, timestamp, data: { tag, payload } }`): `record.addCustomEvent` throws when not
recording, and the page may load on an excluded route.

## Bundle

- `import("rrweb")` kept the whole namespace (record, Replayer, …) in the lazy chunk.
  Importing `{ record }` from a local module (`src/replay/rrweb.ts`) that is the dynamic-import
  target let esbuild tree-shake the replayer: 77.2 KB to 55.3 KB gzip.
- The lazy module must not import a core module (even a constant): esbuild then emits a shared
  `chunk-*.js`, which has no size budget and fails `size:check`. The privacy class names are
  duplicated in `recorder.ts` (core) and `rrweb.ts` (chunk) for that reason.
- Moving rrweb's static `record()` options into the chunk saved about 50 B gzip of core.

## React Native

- `excludeScreens` and `hideScreen()` are a third pause source in the JS controller
  (`sdk/react-native/src/replay.ts`) driving the existing native `pause()` / `resume()`; both
  natives keep `pausedByHost` across foreground (`didBecomeActive`, `onActivityStarted`) and new
  activities, so a third-party activity or view controller (Stripe Identity) stays unrecorded.
- Native `pause()` is `onMain { }` on iOS and Android: from the JS thread it is posted, so it
  takes effect on the main thread's next turn. `onStateChange` arrives after the screen mounted:
  a screen shown without a transition can lose one masked frame first; call `hideScreen()`
  before navigating to it. Not verified in a simulator in P1.
