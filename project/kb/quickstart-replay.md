# Session replay in a quickstart (`@ouo11y/browser` 0.3.0, collector 0.4.0, rum-api 0.5.0, grafana 0.5.0)

Learned building `examples/quickstarts/tiny-shop-replay` (N54), 2026-10-24; rechecked 2026-10-27.

- **Privacy by class or selector.** rrweb gets `blockClass: "ouo-block"`, `maskTextClass: "ouo-mask"` and `maskAllInputs` (default true); since 0.3.0 also `replay.blockSelector` and `replay.maskTextSelector` (0.2.1 had classes only). `type="password"` is masked by rrweb whatever the options.
- **Check masking on disk, not only on screen.** Chunks live in rum-api's filesystem store as `replays/<session>/<seq 6 digits>.json.gz` plus `meta.json`; `docker run --rm -v <project>_rum-api-data:/d alpine sh -c 'zcat /d/replays/*/*.json.gz' | grep -c <secret>` must print 0. The rum-api image has no shell or `ls`.
- **Sizes.** A 13 s session of a tiny page with ~10 interactions (0.3.0): 3 chunks, 2.6 KB gzipped, 15 KB rrweb JSON; `meta.json` has `bytes` and `chunk_count`. With `debug: true` the SDK logs each chunk's raw and gzipped size.
- **4xx is not a failed request** (ADR-0004, `sdk/browser/src/network.ts`): to get "Failed request" on the timeline the demo API must answer 5xx.
- **`captureError` after `await fetch` has no trace id**, so the plugin's "Same traces" log filter is empty for it; the error and the click trace line up by time only (N55; still so in 0.3.0).
- **Automated fast clicks are rage clicks anywhere.** Browser-pane clicks 20 to 40 ms apart, triple-click to select a field included, produce `ouo.rage_click` on inputs. Not a bug: the detector is spatial.
- **Dead click needs no DOM change and no request** after a button click: an empty `onClick` works; a slow fetch does not (the request counts as activity), so the slow button makes a rage click instead.
- **Compose project name.** Without `name:` in `stack/compose.yaml` the project is `stack`; the quickstart sets `name: tiny-shop-replay` so the volume name in the README is stable.
- **npm inside this repo's tree** from a sandboxed agent shell may print "Exit prior to config file resolving"; `npm install --no-workspaces` works. A reader's normal shell is not affected.
