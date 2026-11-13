# Resolving a stack on read: what it costs

Measured 2026-11-13 on the ADR-0022 prototype (`project/agents/symbolication/prototype`, `ouo-symdemo measure`). Apple M5, Go 1.26.2, parser `github.com/go-sourcemap/sourcemap` v2.1.4. Store and resolver in one process over loopback HTTP, filesystem store. Raw numbers: `prototype/demo/results/measurements.json`.

A cold resolve is a store GET, gunzip, parse and lookup with an empty cache. A warm one finds the parsed map in the cache.

| Map | Size | gzip | Cold median (p95) | Warm median | Heap kept | Runs |
|---|---|---|---|---|---|---|
| ouo-web replay engine chunk, one made-up frame | 49 KB | 13 KB | 1.2 ms (1.7) | 0.03 ms | 0.2 MB | 30 |
| ouo-web main bundle, real 10-frame stack | 1.12 MB | 296 KB | 18.9 ms (23.3) | 0.28 ms | 3.0 MB | 30 |
| esbuild bundle of `@grafana/ui`, `@grafana/data`, `monaco-editor`, `ol` (8.6 MB minified), one made-up frame | 33.6 MB | 7.3 MB | 592 ms (631) | 0.59 ms | 64.5 MB | 10 |

- **Cold time is the parse.** It grows with the map, about 17 ms per MB. The store round trip is under 0.3 ms on loopback (the missing-map number). On S3 add one object GET.
- **A parsed map keeps about twice its decompressed size on the heap**, mostly `sourcesContent`. A cache budget counted in decompressed bytes, as rum-api's is, under-counts by half.
- **Peak process memory** for the 33.6 MB map: 167, 212 and 167 MB (`/usr/bin/time -l`, 3 runs, each run parses the map twice and holds the store too). For the 1.12 MB map: 24 MB.
- **Warm time is not the map lookup** (ADR-0011 measured about 12 ns for that). It is the function-name search in `sourcesContent`, which splits the source file per frame. It is still well under a millisecond per stack.
- **gzip keeps 22 to 26%** of a map. One ouo-web release (3 maps, 1.58 MB) is 424 KB on disk with meta and release pointers.
- **A missing map** costs 0.27 ms cold (one 404) and 0.03 ms once remembered (median of 30).

"Made-up frame": one frame in the middle of the bundle's longest line, because no real error was thrown in that bundle. Only the 1.12 MB row is a stack the SDK captured.

## Behaviour

| Case | Result |
|---|---|
| No map for the debug id | every frame `no_map`, the stack returned as recorded |
| Map uploaded after the error | `no_map` until the 60 s miss memory ends, then mapped |
| No debug ids, release matches one upload | mapped through the release pointer |
| No debug ids, wrong release | `no_map` |
| No debug ids, two builds of one release and path | `ambiguous`, not mapped |
| Unknown debug id, release has a map for the path | `no_map` |
| Another project | `no_map` |
| A file that is not a source map | stored, then a miss on read |

Not measured: S3, a real Collector in front, a React Native app on a device, dSYMs.
