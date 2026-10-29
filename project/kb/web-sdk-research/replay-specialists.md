# Appendix E: replay engines and specialists

Status: research, 2026-10-29. How web session replay is built by the engine everyone shares (rrweb and its forks), by the two open-source specialists that wrote their own recorder (Microsoft Clarity, OpenReplay), and, at docs level, by the closed specialists (LogRocket, Fullstory, Hotjar / Contentsquare, Smartlook, Mouseflow, Glassbox). Section 9 answers the cross-cutting questions (masking, canvas, iframes, shadow DOM, assets, compression, buffering, heatmaps, seeking); section 10 says what ouo should do with rrweb.

Citation form: `repo/path:line @ sha12`. Aliases, defined once and used below:

| Alias | Repo @ sha12 (tag) | Read as |
|---|---|---|
| `RR` | rrweb-io/rrweb @ e051ddbf36cc (`rrweb@2.2.0`, 2026-10-24) | release studied; commits after it are cited by their own sha |
| `SR` | getsentry/rrweb @ a946342f59ed (`2.45.0`, 2026-10-28) | Sentry fork |
| `AR` | amplitude/rrweb @ 06a22bd1e63a (`v2.1.5`, 2026-10-22) | Amplitude fork |
| `PH` | PostHog/posthog-js @ dfb2e002db81 (`posthog-js@1.442.1`) | PostHog fork, inlined at `packages/rrweb` |
| `CL` | microsoft/clarity @ 665b68d96ad3 (`v0.8.73`, 2026-10-22); `cjs/` = `packages/clarity-js/`, `cviz/` = `packages/clarity-visualize/` | Clarity |
| `OR` | openreplay/openreplay @ 2008f30172a6 (`v1.28.0`); `trk/` = `tracker/tracker/src/` | OpenReplay tracker (package.json says 19.0.0-beta.0; npm has 19.0.4) |
| `SJ` | getsentry/sentry-javascript @ 30cfb4cbafd1 (`11.10.0-48`) | for Sentry's replay limits only (Appendix A has the rest) |
| `DD` | DataDog/browser-sdk @ 2ee6f07f364d (`v7.16.2`) | for the non-rrweb comparison only (Appendix B has the rest) |

All repos were cloned blobless into a scratch directory; nothing was installed or built. `[docs only]` = vendor documentation, not verified in code. `[derived]` = computed here from code constants or earlier measurements, method stated. "measured here" = run on this machine on 2026-10-29.

## 1. Sources

| Project | Licence | State on 2026-10-29 | Open part |
|---|---|---|---|
| rrweb-io/rrweb | MIT | 2.0.0 GA on 2026-06-01 after 18 alphas (2.0.0-alpha.18 was 2024-12-06); 11 releases since, last `2.2.0` on 2026-10-24; 100 commits on the default branch in 2026 vs 26 in 2025; 20.3k stars; 436 open issues + PRs (GitHub API `open_issues_count`). Packages: `rrweb`, `@rrweb/record`, `@rrweb/replay`, `@rrweb/packer`, `rrweb-player`, `@rrweb/browser-client` (all 2.2.0 on npm) | all |
| getsentry/rrweb | MIT | npm `@sentry/rrweb` 2.45.0 (2026-10-28; the older name `@sentry-internal/rrweb` stopped at 2.43.0 in May 2026). Merge base with upstream `609b7fac` (2024-06-05); 164 upstream commits not in the fork, 427 fork-only commits; 70 commits in 2026 | all |
| amplitude/rrweb | MIT | npm `@amplitude/rrweb` 2.1.5 (2026-10-22). Merge base `57a940a` (2023-10-13); 218 upstream commits missing, 406 fork-only; 132 commits in 2026 | all |
| PostHog rrweb | MIT | `PostHog/posthog-rrweb` archived after `0.0.60` (README: "this code is now inlined into the posthog-js repo"); now `posthog-js/packages/rrweb`, 134 commits in 2026, several titled "port upstream …". Merge base of the archived repo `dc20cd4` (2025-01-10) | all, but README asks others not to use it |
| highlight-run/rrweb | MIT | last commit 2025-05-15 (merge base 2025-03-07). npm `@highlight-run/rrweb` 2.0.0-lambda.9 (2026-08) points its repository field at upstream; LaunchDarkly's `@launchdarkly/session-replay` depends on `@launchdarkly/o11y` | stale |
| microsoft/clarity | MIT | `v0.8.73` on 2026-10-22, betas weekly; 75 commits in 2026. Packages `clarity-js` (recorder, 7,472 lines TS), `clarity-decode`, `clarity-visualize` (player, 2,652 lines), `clarity-devtools` | recorder, decoder, player; backend closed |
| openreplay/openreplay `tracker/` | tracker and tracker-assist MIT (`tracker/tracker/package.json`, `tracker/tracker-assist/package.json:12`); repo mixed (AGPL / ELv2, see mobile Appendix G) | `@openreplay/tracker` 19.0.4 on npm (2026-10-29). Tracker 17,191 lines TS | tracker, player, backend (self-hostable) |
| LogRocket, Fullstory, Hotjar / Contentsquare, Smartlook, Mouseflow, Glassbox | proprietary | docs and blogs only | none |

Docs read: Fullstory "Private by Default" (help.fullstory.com/hc/en-us/articles/360044349073) and "Performance & the Fullstory Script" (help.fullstory.com/hc/en-us/articles/360020624094); LogRocket privacy (docs.logrocket.com/docs/privacy), troubleshooting sessions (docs.logrocket.com/docs/troubleshooting-sessions), "CSS on private domain" (docs.logrocket.com/docs/cssimages-on-a-private-domain); Hotjar "How do Recordings Work: Advanced" and "Troubleshooting FAQs for Recordings" (help.hotjar.com, both 403 to direct fetch, read through search-result extracts); Contentsquare personal data handling (docs.contentsquare.com/en/web/personal-data-handling); Smartlook element masking (web.developer.smartlook.com/docs/masking-rules); Mouseflow "How session replays work" (mouseflow.com/blog/how-session-replays-work/); Glassbox enterprise page (glassbox.com/why-glassbox/enterprise); Clarity masking (learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking); LaunchDarkly (ex-Highlight) rrweb overhead benchmark (launchdarkly.com/docs/tutorials/session-replay-performance).

## 2. Packages and frameworks

| Recorder | How it ships | Size | Framework hooks |
|---|---|---|---|
| rrweb 2.2.0 | ESM/CJS/UMD; 2.0 split `@rrweb/record` (record only) from `rrweb` (record + replay) and moved plugins to their own packages (`RR packages/rrweb/CHANGELOG.md` 2.0.0 entries #1497). 2.0 removed the base64-inlined worker from bundles (#1762, vite 6) but the canvas worker is still imported `?worker&inline` (`RR packages/rrweb/src/record/observers/canvas/canvas-manager.ts:18`); the Chrome-extension build strips `&inline` (`RR vite.config.default.ts:15,234-240`) | ouo's lazy chunk built from `import("rrweb")`: 263,037 B raw, 81,978 B gzip (measured here on `sdk/browser/dist/rrweb-UXYDRUQK.js`, rrweb 2.1.7). It contains the `Replayer` export, rrdom and postcss: a dynamic `import("rrweb")` keeps the whole namespace | none; `recordAfter: 'load' \| 'DOMContentLoaded'` (`RR packages/rrweb/src/record/index.ts:93`) |
| `@rrweb/browser-client` 2.2.0 | new: `record()` plus a WebSocket uploader to rrweb's own hosted service (`RR packages/browser-client/src/index.ts:1-60`, default `wss` URL `api.rrweb.com`) | | |
| Sentry fork | `@sentry/rrweb`, bundled into `@sentry-internal/replay` | build flags `__RRWEB_EXCLUDE_IFRAME__`, `__RRWEB_EXCLUDE_SHADOW_DOM__` and canvas removed by default so they tree-shake (`SR README.md:20-27`; `SR packages/rrweb/src/record/index.ts:63-64,334,384`) | via sentry-javascript |
| clarity-js | async tag from Clarity's CDN, or npm `clarity-js` (`cjs/package.json` `main`/`module`/`unpkg` builds) | not measured here | none; SPA via `history.pushState` / `replaceState` proxies (`CL cjs/src/core/history.ts:9-19`) |
| OpenReplay tracker | npm `@openreplay/tracker`; the worker is a string `WEBWORKER_BODY` injected at build and started from a Blob URL (`OR trk/main/app/index.ts:77,1122-1123`), so CSP needs `worker-src blob:` | not measured here | `@openreplay/tracker-*` plugins (Assist, Redux, etc.) |
| Fullstory | async stub that loads `fs.js` from `edge.fullstory.com` after CSS and images `[docs only]` | "about 80 KB with Brotli, or about 95 KB with gzip" `[docs only]` | |

## 3. RUM

Out of scope for this appendix except where the replay engine produces the signal: rrweb emits no RUM signals itself. Clarity derives click / scroll / resize / input / visibility / script-error / navigation timing events from the same pipeline (`CL cjs/types/data.d.ts:18-78`, event enum; `cjs/src/performance/navigation.ts`), and computes "smart events" (rage / dead clicks) server-side. OpenReplay's tracker has its own RUM modules (`OR trk/main/modules/`: `exception.ts`, `network.ts`, `performance.ts`, `longAnimationTask.ts`, `timing.ts`, `console.ts`). Network capture defaults: `capturePayload: false`, `ignoreHeaders: ['cookie','set-cookie','authorization']`, `failuresOnly: false` (`OR trk/main/modules/network.ts:63-75`).

## 4. Session replay

### E.1 rrweb 2.2.0: the record pipeline

**Start and full snapshot.** `record()` destructures its options with defaults `inlineStylesheet = true`, `recordCanvas = false`, `collectFonts = false`, `inlineImages = false` (`RR packages/rrweb/src/record/index.ts:66-110`). `maskAllInputs: true` expands to every input type; otherwise only `{ password: true }` (`index.ts:141-162`). `takeFullSnapshot` emits a Meta event, resets the stylesheet manager, **locks every MutationBuffer**, calls `snapshot(document, …)` synchronously over the whole tree, emits the FullSnapshot, then unlocks the buffers so mutations that happened during serialisation are emitted against the new mirror (`index.ts:344-427`). There is no time slicing: the snapshot is one task proportional to DOM size. ouo measured it at 10,000 elements: 1,045 KB JSON, a 42 ms block, heap +8 MB (`project/kb/browser-sdk-safety.md`, "rrweb cost").

**Checkouts.** `checkoutEveryNms` / `checkoutEveryNth` are evaluated inside `wrappedEmit` on each incremental event, not on a timer: an idle page does not checkout until the next event (`index.ts:220-240`).

**Mutations.** One `MutationObserver` per document / shadow root with `subtree`, `attributes`, `characterData`, both `OldValue`s and `childList` (`RR packages/rrweb/src/record/observer.ts:83-110`). Each callback runs `MutationBuffer.processMutations` (collect adds / removes / attributes / texts) then `emit()` synchronously in the same task (`RR packages/rrweb/src/record/mutation.ts:151-154`); `emit()` returns early when the buffer is `frozen` or `locked` (`mutation.ts:156-160`, `129-149`). The emitted mutation event serialises each added subtree with `serializeNodeWithId` (`mutation.ts:306`). There is **no mutation limit, no rate limit and no batching across callbacks** in upstream: a page with 10,000 text mutations per second costs 698 ms of script in 10 s and 12.2 MB of replay in ouo's test (`browser-sdk-safety.md`). Blocking an element keeps it out of the replay but its mutations are still observed and walked (open issue #1447, 2024-04-11).

**Sampling options** (`RR packages/rrweb/src/record/observer.ts`): `mousemove` throttle 50 ms, positions flushed every `mousemoveCallback` 500 ms (`:112-160`, defaults `:125,129`); `mouseInteraction` per type (`:206-215`); `scroll` 100 ms (`:354`); `media` 500 ms (`:1054`); `input: 'last'` records only `change` (`:487`); canvas `'all'` (every 2D/WebGL call) or an fps number (`canvas-manager.ts:66-83`).

**`slimDOMOptions`** is off unless passed; `true` drops scripts, comments, favicons, head whitespace and most `<meta>`; `'all'` also drops authorship / description meta and title mutations (`RR packages/rrweb-snapshot/src/snapshot.ts:807-831`).

**`packFn`** (`@rrweb/packer`) is `zlibSync(JSON.stringify(event))` per event with fflate, as a string (`RR packages/packer/src/pack.ts:5-11`). rrweb's own guide says per-event packing "may not get the best result" and recommends compressing the whole session in the backend (`RR docs/recipes/optimize-storage.md:98-104`).

**Stylesheets.** For each `<link rel=stylesheet>` the snapshot finds the matching `CSSStyleSheet` and, when readable, replaces `rel` / `href` with the full text in `_cssText`; `<style>` sheets are stringified too (`RR packages/rrweb-snapshot/src/snapshot.ts:590-616`). This repeats at **every** full snapshot, so every checkout re-sends the page's CSS. Unreadable (cross-origin without CORS) sheets keep their `href` and are loaded by the player. 2.0 deprecated the `inlineStylesheet` / `inlineImages` options in types and docs while keeping the behaviour (#1829). `adoptedStyleSheets` are tracked by a `StyleSheetMirror` that is reset at every full snapshot (`RR packages/rrweb/src/record/stylesheet-manager.ts:16,66-83`).

**Iframes.** Same-origin iframes are serialised when loaded and observed with their own observer set (`snapshot.ts:1137-1170`; `iframe-manager.ts`). Cross-origin iframes need `recordCrossOriginIframes: true` and rrweb running inside the child, which posts every event to the parent with `postMessage(…, '*')` (`RR packages/rrweb/src/record/index.ts:207-217`; parent listener `iframe-manager.ts:56`). At 2.2.0 a **blocked** iframe's document is still serialised and observed; fixed on the default branch two days after the release by `7cdbadf` (#1964, 2026-10-25, unreleased): the iframe branch now checks `_isBlockedElement`. That is the same fix ouo applies with an esbuild patch (`sdk/browser/tsup.config.ts:5-25`).

**Shadow DOM.** `attachShadow` is patched on the window and on each iframe to observe new roots (`RR packages/rrweb/src/record/shadow-dom-manager.ts:50,123-139`). 2.2.0 releases a shadow root's observer and buffer when its host is removed (#1958); before that each removed host leaked an observer for the life of the recording (`CHANGELOG.md` 2.2.0).

**Untainted prototypes.** rrweb reads DOM accessors through `@rrweb/utils` to survive pages (Angular / Zone.js, other monitors) that patch them. `getUntaintedPrototype` decides a prototype is clean only if every listed accessor's getter and every listed method stringify as `[native code]` (`RR packages/utils/src/index.ts:15-34,62-97`). The list still names `querySelector` / `querySelectorAll` as **accessors** of `Element` (`:28`), which have no getter, so the check always fails and rrweb always builds a hidden iframe to take clean prototypes; on Safari it keeps that iframe in the DOM with class `rr-block` (`:118-128`). This is the bug ouo found (`browser-sdk-safety.md`, "Soak"). 2.2.0 reference-counts the Safari helper so it is removed when the last observer stops (`:268-292`, #1971) but does **not** fix the list.

**Canvas.** Off by default. `'all'` patches 2D and WebGL contexts and serialises every call (`canvas/2d.ts`, `canvas/webgl.ts`); a number snapshots each canvas at that fps with `createImageBitmap` and an inline worker that returns a data URL (`canvas-manager.ts:105-232`, `1000 / fps` at `:159`, worker `:122`).

**Media.** No video frames; `rr_mediaState`, `currentTime`, rate and volume are recorded and replayed (`snapshot.ts:737`; 2.0 #1432 "full overhaul of video and audio playback").

**Memory fixes in 2.2.0** (#1971, `CHANGELOG.md` 2.2.0): stopping a recording now releases the root document's MutationBuffer (each start/stop cycle used to leak one), removes the cross-origin `message` listener, observes a same-origin iframe once instead of once per checkout (a single iframe mutation was emitted once per checkout), and ref-counts the Safari helper iframe. `mutationBuffers` is now a `Set` with `delete` on stop (`observer.ts:58,87,106`). These are the two leaks ouo found in its 1 h WebKit and Chromium soaks.

**Player.** `Replayer` uses an rrdom virtual DOM by default to fast-forward (`RR packages/rrweb/src/replay/index.ts:205`). A seek discards everything before the last Meta event at or before the target time and applies the events from there synchronously (`RR packages/rrweb/src/replay/machine.ts:66-79,168-205`): seeking cost is the distance to the previous full snapshot, which is why checkout cadence matters.

**Known performance traps** (from the code above and rrweb's issue tracker): full snapshot of a large DOM is one synchronous task; every checkout re-inlines CSS; no mutation limit (long lists, charts, JS animations; rrweb's own storage guide names "long list, complex SVG, element with JS controlled animation, canvas animations", `optimize-storage.md:15-20`); blocked subtrees still cost observer time (#1447); `<link rel=preload>` memory/CPU issue open (#1707, 2025-06-20); O(n²) mutation ordering was fixed in 2.1.5 (#1652, "has been identified as a problem numerous times").

### E.2 The forks

| Fork | What it changes | Upstream sync | Verdict |
|---|---|---|---|
| Sentry `@sentry/rrweb` 2.45.0 | removes `hooks` and `plugins`; build flags to drop iframe / shadow DOM / canvas; canvas only via injected `getCanvasManager` (`SR README.md:20-27`); `unblockSelector`, `maskAllText`, `unmaskTextClass/Selector`, `maskAttributeFn`, `maxCanvasSize` (`SR packages/rrweb/src/record/index.ts:99-133`); **`onMutation(mutations, {isBlocked})`** called before each batch is processed: `false` skips the batch, an array replaces it (`SR packages/rrweb/src/record/observer.ts:125-150`, #341 2026-10-27); a separate `@sentry/rrweb-worker` package. sentry-javascript uses `onMutation` for its breaker: `mutationBreadcrumbLimit = 750`, `mutationLimit = 10_000` (`SJ packages/replay-internal/src/integration.ts:124-125`) | diverged 2024-06; 164 upstream commits missing; fixes re-implemented locally (e.g. shadow-root teardown #337, iframe and mirror fixes) | the most active fork, shaped to Sentry's integration |
| PostHog (`posthog-js/packages/rrweb`) | ports upstream fixes one by one (`34833f2d` shadow-root release, `52c84e28` "port upstream mutation-buffer O(n²) fix", 2026-10-27/28); PostHog's mutation rate limiter lives in posthog-js, a token bucket `bucketSize 100`, `refillRate 10` per node (`PH packages/browser/src/extensions/replay/external/mutation-throttler.ts:29-42`) | selective ports | not for outside use (README) |
| Amplitude `@amplitude/rrweb` 2.1.5 | opt-in `captureAdoptedStyleSheets` with rule dedupe across buffers and iframes (`AR packages/rrweb/src/record/index.ts:99,356,413`, commits `8ffdd4a`, `cb2e59c`, `443c90f`), native interactions exposed to recorder hooks (`170c07a`) | diverged 2023-10; 218 upstream commits missing | active, far behind |
| Highlight `@highlight-run/rrweb` | | last commit 2025-05 | stale |

Most maintained: upstream rrweb itself (2.2.0 five days ago; October commits by Eoghan Murray and Justin Halsall, by Paul D'Ambra of PostHog, and by outside contributors whose fixes match ouo's findings, e.g. #1964). Among forks, Sentry's (70 commits in 2026, a release yesterday), but it is three years of divergence behind a different API.

### E.3 Microsoft Clarity: its own recorder and format

**Format.** Not rrweb. Every event is an array of tokens `[time, eventType, …]` (`CL cjs/src/layout/encode.ts:19-21`). DOM nodes are sent as `id, parent, previous, tag, attributes…, value` with ids negated when text is mangled (`encode.ts:81-106`). Within each payload, repeated strings are replaced by back-references into the token array (`CL cjs/src/data/token.ts:3-39`). Events are routed to two streams: `p` (playback: Discover, Mutation, Snapshot, stylesheet adoption/update, animation, custom element) and `a` (analytics: everything else) (`CL cjs/src/data/upload.ts:65-83`), sent as one JSON body `{"e": envelope, "a": [...], "p": [...]}` (`upload.ts:190-192`).

**Modules.** `layout` (discover = initial traversal, mutation, style, animation, custom elements, regions), `interaction` (click, scroll, pointer, input, selection, resize, visibility, clipboard, submit, unload, timeline), `performance` (navigation, observer), `diagnostic` (script errors, fraud, internal), `data` (envelope, upload, metrics, dimensions, limits) (`CL cjs/src/`, module list `cjs/src/clarity.ts:22-36`).

**Main-thread cost control.** A cooperative scheduler runs one task at a time (`CL cjs/src/core/task.ts:39-81`). A task checks `task.state(timer)` per node and, after 30 ms (`Setting.LongTask`, `cjs/types/data.d.ts:289`), `suspend()`s: it awaits `requestIdleCallback` with a 5 s timeout and resumes with the idle deadline's `timeRemaining()` as its next budget (`task.ts:9,83-146`); browsers without rIC get a `requestAnimationFrame` + `MessageChannel` polyfill (`task.ts:148-160`). Both the initial discover (`CL cjs/src/layout/discover.ts:15-31`) and mutation processing (`CL cjs/src/layout/mutation.ts:107-155`) yield this way; the MutationObserver callback only queues records (`mutation.ts:107-116`). Upload is 1 s after the first event and then `sequence × 1 s`, between 100 ms and 30 s (`upload.ts:300-305`).

**Mutation throttling** (`config.throttleDom: true` by default, `CL cjs/src/core/config.ts:25`). Each mutation gets a signature `[parent selector, element selector, attribute, added names, removed names]`; outside a 3 s window after user activity, after 10 repeats of the same signature only the latest mutation per signature is kept and processed later; removed nodes are remembered and applied when activity resumes (`mutation.ts:205-255`; `MutationSuspendThreshold = 10`, `MutationActivePeriod = 3000`, history capped at 10,000 keys / 30 s, `cjs/types/layout.d.ts:156-160`). This keeps tickers, carousels and timers from flooding the replay while leaving interaction-driven changes intact.

**Compression and limits.** `CompressionStream('gzip')` on the main thread (async stream), no worker (`CL cjs/src/data/compress.ts:3-17`); compressed bodies go out by XHR with a custom `Accept` header, the last payload by `sendBeacon` uncompressed, with playback dropped if the beacon would exceed 64 KB (`upload.ts:174-187,194-239`; `MaxBeaconPayloadBytes`, `data.d.ts:290`). The first payload carries playback only if it is under 1 MB, otherwise playback waits for the second (`upload.ts:132`; `MaxFirstPayloadBytes`, `data.d.ts:281`). Hard limits per page: 128 payloads, 128 pages per session, 2 h, 10 MB of unsent playback; any of them stops Clarity (`CL cjs/src/data/limit.ts:14-34`; `data.d.ts:264-268`). One retry; a 4xx stops recording (`upload.ts:247-256`; `RetryLimit = 1`).

**Lean mode (Clarity's buffer mode).** With `lean: true`, layout events are kept in memory (up to 10 MB) and not uploaded; `upgrade()` turns lean off and sends **the whole page from its start**, not a ring buffer (`CL cjs/src/data/upgrade.ts:16-36`; lean limit `upload.ts:58-63`).

**Masking defaults.** `content: true` gives every node `Privacy.Sensitive` (`CL cjs/src/core/config.ts:10`; `cjs/src/layout/dom.ts:105`): text is kept but every word containing a digit or `@` is scrubbed (letters → `▪`, digits → `▫`, currency tokens kept) (`CL cjs/src/core/scrub.ts:13-33,158-198`). Inputs, selects and textareas are always masked; values become fixed-length tokens; fields whose attributes contain `password`, `secret`, `pass`, `social`, `ssn`, `code`, `hidden` are excluded entirely; class names containing `address`, `password`, `contact` mask the subtree (`dom.ts:232-291`; lists `CL cjs/src/layout/constants.ts:7-10`). `data-clarity-mask` / `data-clarity-unmask` and selector lists from project settings override (`dom.ts:74-76,253-258`; `cjs/types/layout.d.ts:81-82`). Masked text under strict modes is **mangled to its length** in base 36, so the bytes never leave the page (`encode.ts:105,124-127`; `scrub.ts:116-126`); masked images send only their box size (`encode.ts:94`). Docs: three modes Strict / Balanced (default) / Relaxed `[docs only]`, "Clarity doesn't mask content within style sheets or style tags" `[docs only]` (learn.microsoft.com/…/clarity-masking).

**Assets.** `<link rel=stylesheet>` is sent as-is (tag + `href`), not inlined (`CL cjs/src/layout/node.ts:177-193`, inlined only for Electron `file://` sheets); `<style>` text is sent from `textContent`, or from CSSOM rules when the element has an id or `data-*` attributes (`node.ts:246-258`). The player loads stylesheets and font preloads from their URLs at play time, waits for them before showing a frame, and can go through a CORS proxy (`CL cviz/src/layout.ts:225-226,494-530`; latest commit "visualize: add CORS stylesheet fallback"). `data:` sources on media are blanked so large inline media never ship (`node.ts:195-200`).

**Iframes, shadow DOM, canvas.** Same-origin iframes only (`node.ts:162-176`); `attachShadow` is hooked (`mutation.ts:360-366`); no canvas capture (no `canvas` handling in `cjs/src/layout/`; only `interaction/click.ts` mentions it).

**Heatmaps.** A click carries page coordinates, the target's selector hash, and the click position **relative to the target element** (`eX`, `eY`, precision 32767), plus up to 25 characters of text and the link (`CL cjs/src/interaction/click.ts:30-76`; `data.d.ts:260-271`). The visualizer draws click and scroll maps over the replayed DOM on a canvas (`CL cviz/src/heatmap.ts:61-91`). Element-relative coordinates let one heatmap aggregate clicks across viewports and layout shifts.

**Checkouts.** None: one discover per page view, then mutations (`discover.start` is only called at start and on upgrade, `CL cjs/src/data/upgrade.ts:36`). Seeking in a page view replays from its discover.

### E.4 OpenReplay tracker: own binary format in a worker

**Pipeline.** The main thread collects message tuples in `this.messages` and flushes them to the worker every 30 ms tick (`OR trk/main/app/ticker.ts:39-44`; `trk/main/app/index.ts:375-376,1342-1368`). The worker encodes them into a binary format (varint `uint`, zig-zag `int`, length-prefixed strings, `OR trk/webworker/PrimitiveEncoder.ts:88-110`; generated encoder `MessageEncoder.gen.ts`), builds batches that start with `BatchMetadata` + `Timestamp` + `TabData` (`trk/webworker/BatchWriter.ts:14-21,274-301`), flushes at 200 kB (soft) or every 30 s (`BatchWriter.ts:20-21`; `trk/webworker/index.ts:21,193-194`), and splits streams into `player`, `assets`, `devtools`, `analytics` (`BatchWriter.ts:52-55`). Attribute names and values go through a `StringDictionary` so repeats are sent as keys (`OR trk/main/modules/attributeSender.ts:15-100`).

**Compression in the worker.** Batches over 24 kB are gzipped with `CompressionStream` in the worker; smaller ones go raw (`OR trk/webworker/QueueSender.ts:4-8,94-118`). The code comment records why: compression used to be done on the main thread through a postMessage round trip, and smaller uncompressed batches overtook larger ones, which broke replays; one in-flight entry at a time keeps order (`QueueSender.ts:16-42`; `index.ts:174-178`, issue #4836). Retries: 10 attempts, linear 250 ms backoff (`QueueSender.ts:56-58,126-140`); `keepalive` only while in-flight keepalive bytes stay under 64 KB (`QueueSender.ts:48-51,175-185`).

**Mutations.** One observer, nodes bound / unbound per record and committed at the end of the callback (`OR trk/main/app/observer/observer.ts:265-353`); character-data updates are throttled with a trailing edge unless `disableThrottling` (`observer.ts:261,508,685-728`). No periodic re-snapshot (no checkout logic found by `grep -niE "checkout|full ?snapshot"` in `trk/main/app`).

**Buffer mode ("cold start" / conditional recording).** Two message buffers; every 30 s the tracker restarts (fresh DOM) into the other buffer, so 30–60 s are kept in memory until a condition (error, click, network failure, feature flag, from the server) starts the session and flushes them (`OR trk/main/app/index.ts:267-268,1291-1297,1383-1398,1633-1675`; `trk/main/modules/conditionsManager.ts`). Same design as Sentry's and ouo's.

**Sanitisation.** Text plain by default (`obscureTextEmails: false`, `obscureTextNumbers: false`, `OR trk/main/app/index.ts:333-334`); inputs obscured by default (`defaultInputMode: Obscured`, `obscureInputNumbers`, `obscureInputEmails` true, `trk/main/modules/input.ts:127-130`); `privateMode` masks everything not under `[data-openreplay-unmask]`, opt-in (`OR trk/main/app/sanitizer.ts:36-43`); `domSanitizer(node)` returns Plain / Obscured / Hidden (`sanitizer.ts:5-35`); masked text keeps whitespace and replaces the rest with `*` (`sanitizer.ts:66-69`).

**Assets.** Default `InlineCssMode.Disabled`: "will parse and cache the css file on backend"; options to record linked CSS as adopted stylesheets, to fetch and inline, or to send it as plain `<style>` (`OR trk/main/app/observer/top_observer.ts:13-23`; fetch fallback `observer/cssInliner.ts:1-40`). `resourceBaseHref` rewrites asset URLs for the backend fetcher (`index.ts:1550-1552`).

**Canvas.** Frames captured at a server-provided fps and quality (`index.ts:2081-2082`), encoded to images (webp default), uploaded as `FormData` to `/v1/web/images`, and paused while the canvas is off-screen via `IntersectionObserver` (`OR trk/main/app/canvas.ts:15-22,99-127,311`).

**Assist (live co-browsing).** `@openreplay/tracker-assist` streams the same message batches over socket.io (`messages`, or `messages_gz` for large ones) to an agent's player, and uses WebRTC peer connections for calls, remote control and canvas streams (`OR tracker/tracker-assist/src/Assist.ts:35,158-159,274-314,1173`; `package.json` `socket.io-client ^4.8.3`).

### E.5 Closed specialists `[docs only]`

| Vendor | Capture | Privacy default | Assets | Other |
|---|---|---|---|---|
| Fullstory | full DOM + mutations; listeners only enqueue (19 µs per handler, `sendEvents` 0.11 ms "typical"); "All JavaScript runs on the main UI thread"; captured HTML gzipped in the browser with `CompressionStream`, "Typical compression ratio is 40–60%" (help article 360020624094) | "Private by Default" (opt-in per account): all text masked in the browser to placeholder text of the same length; `.fs-unmask` allow-list, `.fs-mask`, `.fs-exclude`; forms masked for accounts created after 2021-11-10; "Excluded and masked content never leaves the user's device" (360044349073) | CSS and images not uploaded; fetched later by Fullstory's servers with an HTTP cache and a cache shared across a customer's sessions (360020624094) | `fs.js` ≈80 KB br / 95 KB gzip |
| LogRocket | MutationObserver-based DOM recording (docs) | `data-private` excludes an element and its children; password fields never recorded; `redact` vs `lipsum` input modes; optional sanitisation of all text / inputs (docs.logrocket.com/docs/privacy). Default of the text sanitiser not stated in the pages read | fetched at playback by an "asset caching bot"; needs public hosting or `baseHref` for private domains; old hashed CSS must stay available; `<link>` tags moved to the top of `<head>`; `<style>` over 10,000 bytes can break (troubleshooting-sessions, cssimages-on-a-private-domain) | |
| Hotjar (Contentsquare) | initial DOM + MutationObserver changes, sent over a WebSocket (Advanced Explanation, via search extract) | inputs suppressed; element-level suppression | CSS / images loaded from the site at playback; WAF / CDN must allow Hotjar's user agent (Why Recordings Look Broken) | iframes, canvas / WebGL and video player state not captured (Troubleshooting FAQ) |
| Contentsquare web tag | | never collects text typed into `<input>` / `<textarea>`; `data-cs-mask` removes element content; page-level masking from the console; mobile SDKs mask all UI by default, the web tag does not (personal-data-handling) | | |
| Smartlook | | passwords, numbers and forms masked by default; mask (solid bar) vs exclude (striped box) (masking-rules, smartlook-basics) | | |
| Mouseflow | DOM snapshot + mutations + events; sensitive data removed in the browser; values typed in sensitive fields are hashed and matched elsewhere on the page so echoes are excluded too; open shadow DOM supported (blog "How session replays work") | password, phone and card fields excluded | not described | |
| Glassbox | "real-time masking" for mobile and desktop; "Classet" keeps old replays rendering after site code changes (glassbox.com/why-glassbox/enterprise), i.e. server-side retention of historical assets | | historical CSS kept server-side | no technical docs found |

## 5. Transport and OpenTelemetry

None of these recorders speaks OTLP; all post their own payloads. rrweb has no transport (`emit` callback; `@rrweb/browser-client` adds a WebSocket client for rrweb's hosted service). Clarity: XHR with credentials, gzip body, `sendBeacon` for the last payload (`CL cjs/src/data/upload.ts:194-239`). OpenReplay: `fetch` from the worker with `Content-Encoding: gzip` and `keepalive` bookkeeping (`OR trk/webworker/QueueSender.ts:142-196`). Hotjar: WebSocket `[docs only]`. Fullstory: batches with `CompressionStream` `[docs only]`. ouo's choice (rrweb JSON chunks to its own receiver, outside OTLP; ADR-0003, ADR-0007) matches the field: replay bytes travel next to telemetry, keyed by the session id.

## 6. Other features

Heatmaps from replay data: Clarity (element-relative clicks, scroll depth, E.3); OpenReplay and Hotjar `[docs only]` from the same streams. Live co-browsing: OpenReplay Assist (E.4). Text search in replays: no open recorder indexes replay text on the client; Clarity sends click text (≤25 chars) and selector hashes for search and filters (`CL cjs/src/interaction/click.ts:61-76`; `data.d.ts:260-263`). Annotations: rrweb 2.2.0 `record.addAnnotation()` with captions and timeline markers (#1928).

## 7. Performance footprint

| Recorder | Main-thread design | Published / derived numbers |
|---|---|---|
| rrweb | synchronous full snapshot; mutation processing and serialisation inside the observer callback; compression and upload left to the host | 10k elements: 42 ms block, 1,045 KB snapshot, 698 ms script per 10 s under 10k mutations/s (measured in ouo, `browser-sdk-safety.md`). LaunchDarkly (ex-Highlight) benchmark of `record()` on a React list on a 4-core EC2: +17 ms per 100-item insertion, +70 ms per 500-item insertion, +6 MB / +60 MB heap, +21–25 % CPU active time `[blog only]` |
| Clarity | 30 ms slices yielding to `requestIdleCallback`; observer callback only queues; gzip via `CompressionStream` | per-page caps 10 MB / 128 payloads / 2 h (`limit.ts`) |
| OpenReplay | 30 ms tick posts tuples to a worker; binary encoding, dictionary and gzip in the worker | flush 200 kB / 30 s; gzip only above 24 kB |
| Datadog (own recorder, Appendix B) | mutations batched and processed in `requestIdleCallback` with a 16 ms min / 100 ms max delay (`DD packages/browser-rum/src/domain/record/mutationBatch.ts:11-38`); segments of 5 s or 60 KB (`DD packages/browser-rum/src/domain/segmentCollection/segmentCollection.ts:15-20`); deflate in a worker | "less than 100kB/min" `[docs only]` |
| Fullstory | main thread, enqueue-only handlers | 40–60 % compression `[docs only]` |

**Bytes per minute, rrweb vs Clarity `[derived]`.** Not measured with a browser here (jsdom would not be representative). From ouo's own chunks (`project/kb/rrweb-chunking.md`): an idle 5 s chunk with one mouse move is 0.26 KB gzip, so the envelope floor is about 12 × 0.26 ≈ 3 KB/min; continuous mouse movement adds up to two `MouseMove` events per second (50 ms sampling, 500 ms flush), about 0.4–0.5 KB JSON each, ≈ 50 KB/min JSON before gzip; each checkout re-sends the full snapshot including all readable CSS (50–300 KB JSON on a storefront, 4–5× gzip → 10–75 KB per checkout, i.e. 2–15 KB/min amortised at ouo's 5 min cadence). Clarity's differences, all byte-reducing: no checkouts, linked CSS sent as a URL, per-payload string dedupe, repeated mutations collapsed, masked text sent as a length. The largest single difference on a real page is the CSS: rrweb inlines it at every snapshot, Clarity never. The size of that difference depends on the page's CSS weight and is the number Appendix M should measure (snapshot bytes with and without `_cssText`).

## 8. Blog-to-code grounding

| Claim | Grounding |
|---|---|
| rrweb 2.2.0 "Fix record-side memory leaks" (changelog) | `RR packages/rrweb/src/record/observer.ts:58,87,106` (`Set` + delete), `packages/utils/src/index.ts:268-292` (ref-counted helper) |
| rrweb blocked iframe no longer recorded (#1964) | `7cdbadf` `packages/rrweb-snapshot/src/snapshot.ts:1136-1140` on main, not in 2.2.0 |
| Sentry "mutation limit" | `SR packages/rrweb/src/record/observer.ts:125-150` hook; `SJ packages/replay-internal/src/integration.ts:124-125` limits |
| Clarity "minimal performance impact" | `CL cjs/src/core/task.ts:83-146` (30 ms slices, rIC), `cjs/src/layout/mutation.ts:205-255` (throttle) |
| Clarity "masks sensitive content by default" `[docs]` | `CL cjs/src/core/config.ts:10`, `cjs/src/layout/dom.ts:105,232-291`, `cjs/src/core/scrub.ts:158-198` |
| OpenReplay "compression in a web worker" | `OR trk/webworker/QueueSender.ts:94-118` |
| Fullstory "captured data compressed with CompressionStream", servers fetch CSS | not verifiable (closed) |

## 9. Questions asked and answers

**Is rrweb 2.x still alpha?** No. 2.0.0 shipped 2026-06-01; 2.2.0 on 2026-10-24 (`RR packages/rrweb/CHANGELOG.md`). ouo pins `^2.1.7`, so `2.2.0` is inside the range but the lockfile holds 2.1.7.

**Which rrweb line is best maintained?** Upstream: 11 releases in five months, memory and Safari fixes landing within days, contributors from Sentry, PostHog and outside. Every fork is behind it (164, 218, 124 commits) and ports fixes selectively (`PH` commit titles "port upstream …").

**Masking by default vs allow-list?** Four positions in the field: (1) mask all text, allow-list to reveal: Sentry (`maskAllText = true`, `blockAllMedia = true`, `SJ packages/replay-internal/src/integration.ts:120-122`), Fullstory Private by Default, OpenReplay `privateMode` (opt-in); (2) pattern redaction of text: Clarity Balanced (digits, emails); (3) inputs only: rrweb with `maskAllInputs`, OpenReplay default, LogRocket, Hotjar, Contentsquare web, ouo today; (4) everything visible: rrweb's own default (`{ password: true }` only, `RR packages/rrweb/src/record/index.ts:162`). All open ones mask in the browser. Upstream rrweb has `maskTextSelector` and `maskTextFn(text, element)` (2.0 #1310) but no `unmaskTextSelector`: an allow-list on upstream needs `maskTextSelector: '*'` plus a `maskTextFn` that returns the text for elements under an unmask marker.

**Canvas / WebGL?** rrweb: opt-in command replay or fps bitmaps (E.1). OpenReplay: fps images to a separate endpoint, paused off-screen (E.4). Sentry: opt-in canvas manager. Clarity, Hotjar: none.

**Iframes?** Same-origin: rrweb, Clarity, OpenReplay. Cross-origin: rrweb (`recordCrossOriginIframes`, recorder inside the child, `postMessage '*'`) and OpenReplay (`crossdomain` option, `OR trk/main/app/index.ts:175,336-338`). Hotjar: none `[docs only]`.

**Shadow DOM and web components?** All three open recorders patch `attachShadow`; closed roots are invisible to all. rrweb 2.2.0 and Sentry 2.44+ release observers of removed hosts. Amplitude and rrweb record `adoptedStyleSheets`, which web components use heavily.

**Video?** Nobody records video frames from a `<video>`; rrweb and OpenReplay replay media state; Clarity blanks `data:` sources; Hotjar does not capture player state `[docs only]`.

**Fonts and CSS: inline vs fetched at play time, server caching?** Three models. Inline at record time: rrweb (`_cssText` per snapshot), OpenReplay's inline modes; self-contained, works for localhost, auth-gated and rotated assets, costs bytes at every checkout. Reference and fetch in the viewer: Clarity's player (with optional CORS proxy); costs nothing on the wire, breaks on private hosts and CORS. Reference and fetch server-side with a cache: OpenReplay default, Fullstory, LogRocket, Hotjar, Glassbox `[docs only]` for the closed ones; needs a crawler, public assets and retention of old hashed files (LogRocket's checklist). rrweb's own guide suggests the server-side variant: extract CSS from events and store one copy (`RR docs/recipes/optimize-storage.md:106-114`).

**Compression ratios?** ouo measured 4–5× on full snapshots, small chunks dominated by the envelope (`rrweb-chunking.md`); Fullstory "40–60 %" `[docs only]`; Datadog "<100 kB/min" `[docs only]`. Per-event `packFn` compresses worse than whole-chunk gzip (rrweb guide). Clarity and OpenReplay reduce before gzip (token / string dictionaries).

**On-error buffer modes?** Ring buffer of two checkouts: Sentry (`BUFFER_CHECKOUT_TIME = 60_000`, `SJ packages/replay-internal/src/constants.ts:27`), OpenReplay cold start (30 s cycles), ouo (30 s). Whole-page buffer: Clarity lean mode, up to 10 MB, sent retroactively from page start.

**Text search?** Not done client-side by any recorder read. Clarity indexes click text and selectors; a backend can index text from full snapshots at ingest, but masked text is gone by design.

**DOM-based heatmaps from replay data?** rrweb click events carry a per-recording node id and viewport coordinates, which do not aggregate across sessions. Clarity carries a selector hash and element-relative coordinates, which do (E.3). PostHog records heatmap events separately from rrweb (Appendix C).

**Replay without rrweb?** Clarity (token arrays, URL stylesheets, time slicing), OpenReplay (binary messages in a worker), Datadog (own serializer, idle-time mutation batches, deflate worker, Appendix B), and the closed vendors. All keep the same architecture: snapshot + MutationObserver + event stream, rebuilt as DOM in a sandboxed iframe at play time.

**Seeking in long sessions?** rrweb seeks from the last Meta / full snapshot before the target (`RR packages/rrweb/src/replay/machine.ts:66-79`), so cadence bounds seek cost (ouo: 5 min, Sentry buffer 60 s). Clarity and OpenReplay have no checkouts; seeking replays from the page view's start, which is cheap because page views reset the stream on navigation.

**Mobile vs desktop viewports?** All record the viewport size (rrweb Meta + `ViewportResize`; Clarity `Document` + `Resize` events) and the player scales the iframe; Clarity's element-relative clicks make one heatmap valid across widths.

## 10. Takeaways for ouo

**Stay on upstream rrweb.** Upstream is now the best-maintained line: GA since June, fixes for exactly the leaks ouo found landed in 2.2.0, and ouo's blocked-iframe patch is merged upstream (unreleased). The forks are years behind (Sentry 2024-06, PostHog 2025-01, Amplitude 2023-10), shaped to one product, and PostHog asks others not to use its copy. Owning a recorder is the path Clarity, OpenReplay and Datadog took (4,500–17,000 lines each for the recorder alone, plus a player); not justified while rrweb is maintained and ouo's player is `rrweb-player`. Revisit only if the CSS / checkout bytes measured in Appendix M dominate storage and cannot be cut server-side.

| # | Action | What it copies | Cost |
|---|---|---|---|
| 1 | Upgrade to rrweb 2.2.0 now; re-run the 1 h WebKit and Chromium soaks; drop the esbuild patch in `tsup.config.ts` when the release after 2.2.0 ships #1964 | upstream fixes #1971, #1958, #1964 | 0.5 day + soak time |
| 2 | Import `@rrweb/record` instead of `rrweb` in `recorder.ts`: the lazy chunk today carries the `Replayer`, rrdom and postcss (measured here) | Sentry's tree-shaking intent, without a fork | 0.5 day; measure the chunk before / after in Appendix M |
| 3 | Send the `getUntaintedPrototype` list fix upstream (`querySelector*` are methods; Safari has no `ShadowRoot.getSelection`), so rrweb stops building helper iframes on clean pages | ouo's own finding | 1 day |
| 4 | Move `JSON.stringify` + gzip of chunks into a worker, one chunk in flight, ordered by `seq`; keep the uncompressed `pagehide` path; drop the second per-event `JSON.stringify` used for size estimates (estimate from the serialised chunk instead) | OpenReplay `QueueSender`, Datadog deflate worker | 2–3 days; CSP note for `worker-src` (a served worker file avoids `blob:`) |
| 5 | Mutation breaker: count adds + attribute + text changes per emitted mutation event; above a per-5 s budget (Sentry stops at 10,000) stop the recorder for the page view with `ouo.replay.skipped` and the reason, like the snapshot-size guard. Then propose an `onMutation` hook upstream (Sentry's #341 shape) so a Clarity-style signature throttle can run before rrweb serialises | Sentry breaker; Clarity throttle | breaker 1–2 days; upstream hook 2–3 days plus review |
| 6 | Stylesheet dedupe on the server: in the replay exporter or rum-api, hash every `_cssText` and `adoptedStyleSheets` text, store it once per project (content-addressed), keep a reference in the stored chunk and restore it when serving `/replay/events`. Bytes on the wire stay; storage drops by the CSS share of every checkout. A client-side variant (send the hash, upload the text once per session) cuts wire bytes too | rrweb guide, Fullstory / OpenReplay asset caches, without crawling | server 3–4 days; client variant +1 week |
| 7 | Privacy default: mask all text by default with an allow-list (`ouo-unmask`), via `maskTextSelector: '*'` and a `maskTextFn` that returns the original text under an unmask ancestor; offer a "balanced" mode that only scrubs words with digits or `@`, as Clarity does; keep `maskAllInputs`. Update `docs/operations/masking-proof.md` | Sentry, Fullstory Private by Default, Clarity Balanced | 1–2 days + masking-proof run |
| 8 | Heatmap-ready clicks: emit the click as an OTel event with a stable selector hash and element-relative position (Clarity's `eX`/`eY`), not from rrweb node ids | Clarity click encoding | 1–2 days SDK; aggregation is a plugin feature |

Not recommended now: canvas recording (opt-in only, large), cross-origin iframe recording (needs the SDK in the child frame), live co-browsing, crawling customer assets (fails on localhost, auth and rotated hashes, which is where ouo's self-hosted users are).
