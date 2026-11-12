# OpenTelemetry JS and browser quirks met while rebuilding the web SDK

Found on 2026-11-11 and 2026-11-12 with `@opentelemetry/api` 1.9.1, `sdk-logs` / `otlp-transformer` / `instrumentation-fetch` 0.222.0, `sdk-trace-base` 2.11.0, Playwright 1.64.1, vitest 5.0.3, Node 24.15, npm 11.12.1.

## OpenTelemetry JS

| What | What happens | What works |
|---|---|---|
| Fetch and XHR instrumentations patch in their **constructor** | `new FetchInstrumentation()` already wrapped `fetch`; capturing "the original" after constructing it captures the wrapper | Take the originals before constructing |
| `disable()` does not unwrap | The wrapper stays, inert. Over init and shutdown cycles wrappers pile up | Put back the original at shutdown, only if `globalThis.fetch` is still the wrapper the SDK installed |
| The fetch span ends about 300 ms after the response | The instrumentation waits for a resource-timing entry | Tests wait before asserting on spans; a page closed inside that window ends the span as abandoned |
| `otlp-transformer`'s root import pulls every serializer | The protobuf writer landed in the eager chunk (+3.6 KB gzip) | Import `@opentelemetry/otlp-transformer/build/esm/logs/json`, `.../trace/json`, `.../logs/protobuf` |
| The protobuf logs serializer is hand-written | No `protobufjs` at runtime; it also deserialises the response (`partialSuccess`) | Used for replay chunks: 7 KB gzip with the engine |
| A `Uint8Array` body is `bytesValue` only if `instanceof Uint8Array` holds | In jsdom the test's `TextEncoder` returns a Node-realm array and the body is encoded as something else | Wrap once: `new Uint8Array(b.buffer, b.byteOffset, b.byteLength)` (a view, no copy) |
| Context and propagation exist only as globals | The instrumentations cannot be handed a private context manager or propagator | Register them when the host has none; leave a host's own |
| `browserDetector` sets `user_agent.original` even when `browser.brands` exists | The spec says to omit it then | Copy the detected attributes and delete it |
| A number as `timestamp` | Treated as epoch ms when it is larger than `performance.timeOrigin`, as `performance.now()` otherwise | Always pass epoch ms |

## Browsers

| What | What happens | What works |
|---|---|---|
| IndexedDB at page close | A write that needs a callback (`add().onsuccess` then `put`) never commits; a database opened during `pagehide` is never written | Open the database at start. Make the key yourself, issue every `put` in one task and call `transaction.commit()` |
| The same, on WebKit | Even a committed write that starts in `pagehide` is lost | Store early: copy a batch to the outbox when its first attempt fails, while the page is alive |
| Storing every batch at page close | The keepalive answer is never seen, so the next page sends the batch again: duplicates on every navigation | Store at page close only when the collector has been failing, the browser is offline, or the keepalive budget is spent |
| A stored entry and its sender | Another tab's drain resends an entry the first tab is still sending | The drainer leaves entries younger than 15 s alone |
| WebKit and a refused connection | Playwright's `pageerror` gets "... due to access control checks" lines: the browser's network log, not an exception | Filter them in the transcript comparison |
| Dead-click detection | An observer installed a microtask after the click misses what the page's handler did in the same task | Install it in the capture phase of the click |
| SVG `foreignObject` from a `blob:` URL | Taints the canvas in Chromium | A `data:` URL |

## jsdom and vitest

- `globalThis !== window` in vitest's jsdom environment. A check such as `event.target !== globalThis` is wrong there; ask what the target is instead (`typeof target.tagName === "string"`).
- No Web Locks, no `PerformanceObserver` for vitals, no `CompressionStream` problems (Node has it). What needs them is tested in Playwright.
- A response the fake collector decodes asynchronously (gunzip) can land in the next test; give the helper an epoch that `reset()` bumps.

## npm in a git worktree on this Mac

`npm` at a worktree root under `.claude/worktrees/` fails with `Exit prior to config file resolving` / `call config.load() before reading values`. The real error is hidden: npm walks up to the shared checkout's `package.json`, maps its workspaces, and one of them (`sdk/browser/package.json` there) has merge-conflict markers. The worktree itself is fine.

```bash
npm --prefix "$PWD" ci        # at the worktree root: an explicit prefix stops the walk
```

Running npm from inside a workspace folder also works.
