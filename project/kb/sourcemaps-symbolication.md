# Source maps and symbolication (web)

Built 2026-10-24 for N36 part C / A10 web ([ADR-0011](../../docs/adr/0011-source-maps-and-symbolication.md), user guide [docs/sourcemaps.md](../../docs/sourcemaps.md)). This entry records what is not obvious from the code.

## Debug ids at runtime

- No browser API reads a script's `//# debugId=` comment. The only way to learn a bundle's id at runtime is code inside the bundle. `ouo-sourcemaps inject` appends a snippet that takes the first `scheme://...` URL of its own `new Error().stack` (its script) and sets `globalThis.__ouoDebugIds[url] = "<id>"`. The SDK only checks `stack.includes(url + ":")` per registered URL. Sentry keys `_sentryDebugIds` by the raw stack and parses it in the SDK. ouo moved the parsing into the snippet because the SDK's core bundle was 35 bytes over its 44.0 KB budget after the #72 / #66 / #80 merges (2026-10-25).
- **Append, never prepend.** Code added after the last line moves no mapping. Prepending would shift every line and force a rewrite of `mappings`, which is what `sentry-cli` does and why it rewrites maps.
- Vite's `build.sourcemap: "hidden"` writes `<file>.map` with no `sourceMappingURL` in the bundle. The CLI looks for a sibling `.map` when no comment names one.
- Rollup can write `//# debugId=` itself (`output.sourcemapDebugIds`). The CLI keeps that id and adds only the snippet.
- **terser** writes `//# sourceMappingURL=` on the same line as the code (no newline). The CLI therefore parses the *trailing* `debugId` / `sourceMappingURL` comments wherever they start, and rejects quoted values so code ending in a string is not mistaken for one.
- **tsup + terser:** tsup 8.5.1 passes terser's map on only when `terserOptions.sourceMap` is set. Without it, `dist/*.js.map` is esbuild's pre-minify map, which matches nothing (found on session B's build, 2026-10-24).
- The id is a UUID derived from the SHA-256 of the map, with version 4 and variant bits set. Rebuilding the same output gives the same id, so re-uploads are idempotent.
- The SDK reads the registry on every exception (one entry per bundle, no cache), so bundles loaded lazily later are picked up.

## `github.com/go-sourcemap/sourcemap` v2.1.4

- `Source(genLine, genColumn)` takes a **1-based line and a 0-based column**, and returns a 1-based line and a 0-based column. Stack traces print 1-based columns, so pass `col-1` and add 1 back.
- The returned `name` is the mapping's name at that exact position. At a throw site that is `Error` or nothing. At a call site it is the **callee** (what the caller calls), which is Sentry's old "caller name" rule.
- For React components the caller rule gives `Component` (React's `renderWithHooks` variable), not `RenderBomb`. So the symbolicator first looks for the enclosing function in `sourcesContent`: it walks back from the original line to the nearest unmatched `{` whose line declares a function. It falls back to the caller rule. This is a heuristic (strings and comments are not parsed), but Vite, webpack and esbuild embed `sourcesContent` by default.
- `Parse("", b)` leaves relative `sources` as they are (`../../src/App.tsx` from Vite, `webpack://<name>/./src/...` from webpack). The display path strips the `scheme://<name>/` prefix and the leading `../`.
- `SourceContent(src)` must be called with the source string as returned by `Source`, not the cleaned display path.

## Storage and caching

- Maps share the replay bucket (`<data dir>/sourcemaps/` or `[<prefix>/]sourcemaps/`) through `replay.Objects`, a plain key-value view. Those objects carry no `ouo-retention` tag, so the replay lifecycle rules never touch them. `Store.Sweep` expires them by the meta object's modification time, which is the upload time.
- The release index key is `sha256(release)/sha256(URL path)`. The host is dropped so one upload serves every CDN host. The index ignores `?query` too.
- Cache: an LRU of parsed consumers per index key with a TTL (10 min), plus a 60 s negative entry for misses. Backend errors are not cached. An upload evicts the key on the replica that received it.

## Local quirk hit on 2026-10-24

The main checkout (`~/Desktop/personal/ouo/package.json`) had merge-conflict markers, and npm 11 walks up from a worktree looking for a workspace root that includes it. Every `npm` / `npx` in the worktree then failed with "Exit prior to config file resolving", which hides the JSON parse error. Running `@npmcli/config` by hand shows the real error. Workaround without touching that checkout: `npm --prefix <worktree> ...`, or `npm` / `npx` shims on `PATH` that add it (also needed for `ouo-env up`, which builds the plugin with npm).
