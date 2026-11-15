# R8 mappings: what R8 8.12 writes, and the emulator check

Written 2026-11-15 while building ADR-0027 (`libs/ouo-go/symbolicate/proguard.go`).

## The format, as R8 8.12.14 (AGP 8.12.0) writes it

- Header comments: `# compiler: R8`, `# {"id":"com.android.tools.r8.mapping","version":"2.2"}`, `# pg_map_id: <sha256>`.
- A class: `original.Class -> obf.Class:`, then `# {"id":"sourceFile","fileName":"MainActivity.kt"}` (unindented) for its source file. Classes R8 removed after inlining all of them are still listed, as `-> R8$$REMOVED$$CLASS$$0:`, so their source file is known.
- A method: `    a:b:ret name(args):c:d -> x`. `a:b` is the obfuscated line range, `c:d` the original. `:c` alone (no `d`) means every line of the range is line `c` (the call site of an inlined callee in its caller). `0:0` or `:0` means "no line" (synthetic code).
- **Inlining**: several lines with the same `a:b` and the same `x`, innermost first; a method inlined from another class is qualified (`int dev.ouo.sample.Prices.sum(java.util.List):39 -> run`). The sample crash is five methods deep in one obfuscated frame.
- **Synthetic**: `# {"id":"com.android.tools.r8.synthesized"}` indented under a member line marks that method; unindented under a class line, the class (lambdas: `MainActivity$$ExternalSyntheticLambda1 -> a.b` with source file `R8$$SyntheticClass`). R8's `retrace` drops synthetic rows when other rows remain; the lambda's `run()` frame disappears from the output.
- Fields are `    type name -> x` (no parentheses); `residualsignature` comments follow some members. Both are ignored.

## The runtime side

- With AGP 8.12 the frames' file name is not `SourceFile` but `r8-map-id-<pg_map_id>` (R8 writes its own map hash into the source file attribute). That hash identifies the mapping too, but only when R8 renames the source file attribute (a `-renamesourcefileattribute` or `-keepattributes SourceFile` rule changes it, and library frames do not carry it), so ADR-0027 keeps its own id from the Gradle step and lists the hash as founder question O2.
- `Throwable.stackTrace` on Android gives the obfuscated class, method and line; `Signals` already records exactly that (`module`, `function`, `filename`, `lineno`).

## Rules `ouo-go/symbolicate` follows (match R8's `retrace` on the fixture)

1. Class not in the mapping: frame kept (`no_map`).
2. Line in an obfuscated range: that inline group; original line = `c + (line - a)` when `d - c == b - a`, else `c`; no original numbers: the line itself.
3. No line, or a line outside every range: an entry without a range, else any entry, only when all of them name one original method; otherwise `unmapped` (not guessed).
4. Synthetic rows dropped when others remain.
5. The exception class in the first stack line is retraced.

Not covered: outlines (`outline` / `outlineCallsite` metadata), `rewriteFrame` (R8's rewrite of NPE frames), fields in messages.

## How it was verified (2026-11-15)

1. `cd sdk/android && ./gradlew --offline :sample:assembleRelease`: the APK holds `assets/ouo-debug-meta.properties` with the same UUID as `sample/build/outputs/ouo/release/mapping-id.txt`.
2. On an emulator of our own (AVD `ouo-w9`, Android 15, `-port 5596 -no-window -read-only`, killed with `adb -s emulator-5596 emu kill`; another session's `emulator-5590` was left alone): `am start -n dev.ouo.sample/.MainActivity --ez crash true`, then a second start, which logs the report `Signals` wrote. It carries `"mapping_id"` and the obfuscated frame `a.b.run(...:80)`.
3. R8's own `retrace` (`$ANDROID_HOME/cmdline-tools/latest/bin/retrace mapping.txt stack.txt`) gave `libs/ouo-go/symbolicate/testdata/proguard/stack-retrace.txt`; `TestRetraceMatchesR8` checks the Go output equals it.
4. Live: Muninn built from `services/muninn` on port 34917 with a filesystem store and the upload token of project `demo`; `ouo-sourcemaps upload-proguard <mapping.txt> --id-file <mapping-id.txt>` answered 201, then 200 for the same file again; `symbolicate.New(&ouogo.Muninn{...}).Resolve` on the report gave the five original frames.
