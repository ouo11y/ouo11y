# symbolication tracker

| Item | State |
|---|---|
| Read rum-api's source-map code, the CLI, the plugin's stack view, archived kb, vendor internals | done 2026-11-13 |
| Options for storage, upload, resolution and lookup | done, in ADR-0022 and the report |
| Web prototype: upload a real map, resolve a real stack from `@ouo11y/browser` 0.4.0 | done, `prototype/demo/run.sh` |
| Measurements: cold and warm latency, memory, storage, missing and mismatched maps | done, `prototype/demo/results/measurements.json` |
| Hermes: resolver on rum-api's two-bundle fixture | done (test); no device run |
| ADR-0022, report, kb entries | done, proposed; the founder decides D1 to D6 |
| Muninn debug-file routes, Collector upload route, `ouo-go/symbolicate`, CLI changes (409, dSYM slices) | not started: after the founder's decisions |
| dSYM in the new store, R8 retrace | design only |

Commands:

```bash
cd project/agents/symbolication/prototype && go vet ./... && go test ./...
project/agents/symbolication/prototype/demo/run.sh
lychee --offline --no-progress --exclude-path node_modules --exclude-path /dist/ './**/*.md' './**/*.html'
```
