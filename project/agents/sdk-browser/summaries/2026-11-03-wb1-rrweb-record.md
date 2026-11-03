# 2026-11-03: WB1, replay chunk from `@rrweb/record`

Work package WB1 of the web roadmap ([roadmap.md](../../../kb/web-sdk-research/roadmap.md) §2). The founder asked for "P0", the first package of that order.

## What was done

- `sdk/browser` loads `@rrweb/record` 2.2.0 instead of the full `rrweb` 2.1.7 package. `@rrweb/record` is the recorder alone; the full package also bundled rrweb's replayer, which the SDK never runs.
- The lazy replay chunk is 22.1 KB gzip instead of 77.2 KB (`npm run size`, gzip -9; 22,584 B with `gzip -9`). The WB1 exit criterion was under 30,000 B. The core entry is unchanged at 44.0 KB.
- The chunk is now named `dist/record-*.js`, after its module. `size-budget.json` (`record-*.js`: 23.0 KB, was `rrweb-*.js`: 82.0 KB) and the source-map probe in `scripts/compat.mjs` follow it.
- The build-time patch for blocked iframes (`tsup.config.ts`) now targets `@rrweb/record/dist/record.js`. 2.2.0 still has the bug and the same `getUntaintedPrototype` lists (checked by diffing 2.1.7 and 2.2.0). The fix, rrweb-io/rrweb#1964, is not in a release.
- rrweb 2.2.0 over 2.1.7: the recorder diff is mostly leak fixes (MutationObserver constructor released per user, one `message` handler for all iframe windows, per-shadow-root cleanup on removal), which is what the soaks look for.
- The plugin's `rrweb-player` moves from 2.1.7 to 2.2.0 (exact pin as before). Without it, npm hoists rrweb 2.2.0 next to `rrweb-player` / `@rrweb/replay` 2.1.7 and the plugin's replayer runs mixed versions. The two packages share one lockfile, so this stays in one PR.
- Docs: README sizes (44 KB core, 22 KB recorder chunk) and the patch note, `examples/fast-tracked/20-frontend.md` (chunk name, sizes, package names), `project/kb/browser-sdk-safety.md` (the prototype check is unchanged in 2.2.0).

Dependencies: `@rrweb/record` ^2.2.0 replaces `rrweb` ^2.1.7 (same project, recorder only, 55 KB gzip less for every sampled session); `@rrweb/types` ^2.2.0 and `rrweb-player` 2.2.0 follow the version.

## Verified

- `sdk/browser`: typecheck, 180 unit tests, `size:check`, `compat:check` (es-check ES2022, source maps of all three files, inert in Node).
- `plugins/ouo11y-rum-app`: typecheck, 201 tests, production build.
- Playwright e2e on this Mac, three engines (`npm run test:e2e`, replay, CSP + Trusted Types, faults, delivery): 59 of 60 passed. The miss was Firefox's Web Vitals test (no TTFB within 10 s) at load average 5; alone it passed 3 of 3 (`--repeat-each 3`). It does not touch replay.
- Soaks: `browser-soak` workflow on the CI runners, 60 min per engine, Chromium and WebKit: SOAK_RUN.

## Not done

- The web benchmark (`project/agents/web-sdk-research/tools/web-bench`) was not re-run. The recorder code is the same in both packages, so main-thread time per minute should only move by what 2.2.0 changed; the gated measurement is WB10.
- Sending the `getUntaintedPrototype` fix upstream (WB1's last item) is an outward-facing step for the founder to approve.

## Next agent

- When an rrweb release contains #1964, the patch in `tsup.config.ts` fails the build (the find string is gone): delete the patch and its README note.
- npm in a `.claude/worktrees/*` folder fails with "Exit prior to config file resolving" while the shared main checkout has package.json files with merge-conflict markers (npm walks up to find a workspace root). Run npm with `--prefix "$PWD"` from the worktree root.
