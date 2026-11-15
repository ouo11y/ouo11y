# ADR-0027 R8 / ProGuard mappings: a build-time mapping id, upload to Muninn, retrace on read

Status: **proposed** (2026-11-15). Extends [ADR-0026](0026-debug-files-and-erasure-without-rum-api.md), which reserved the Muninn kind `proguard` and left "R8 retrace is later work". NDK (C/C++) symbols are a separate later piece (pull request #163 captures NDK crashes; their symbols are not part of this ADR).

## 1. Context

A release Android build is minified by R8: classes, methods and line numbers in a JVM stack are renamed (`a.b.c(SourceFile:3)`). The Android signals (`sdk/android`, [ADR-0017](../adr-archive/0017-android-signals-and-opentelemetry-android.md)) already record crashes and hangs as JVM frames (`module`, `function`, `filename`, `lineno`, in `ouo.crash.frames`). R8 writes `mapping.txt` next to the build; nothing in the stack tells which build's mapping applies. A JavaScript bundle carries a debug id and a dSYM carries its `LC_UUID`; a dex file carries nothing usable.

## 2. Decision

1. **A mapping id per minified build.** A Gradle script (`sdk/android/gradle/ouo-mapping.gradle`, applied by the app) gives every variant with `minifyEnabled` a fresh random UUID at build time, writes it into the APK as the asset `ouo-debug-meta.properties` (`mapping_id=<uuid>`), and next to the build as `build/outputs/ouo/<variant>/mapping-id.txt` for the CI step. Random, not derived from the mapping: the asset goes into the APK before R8 has written the mapping. Sentry's Android Gradle plugin does the same (`io.sentry.ProguardUuids`).
2. **The SDK sends it.** `Signals` reads the asset once at `init` and puts `mapping_id` in every report it writes (crash, hang, termination with a stack); the React Native SDK emits it as `ouo.exception.mapping_id` on the `exception` record ([mobile-sdk spec](../specs/mobile-sdk.md) C2). No asset (a debug build, an app without the script): no attribute.
3. **Upload from CI.** `ouo-sourcemaps upload-proguard <mapping.txt> --id <uuid> | --id-file <mapping-id.txt>` PUTs the gzip mapping to Muninn kind `proguard` under that id ([Muninn spec](../specs/muninn.md) 13; the kind and its 256 MiB limit exist since ADR-0026). Write-once as every debug file: the same mapping again is 200, another under the same id is 409.
4. **Retrace on read** in `libs/ouo-go/symbolicate`: an exception with JVM frames and a mapping id is resolved with that id's mapping or not at all (`no_map`); there is no release fallback (one store version has one mapping per variant, but the id is always there when the script is applied). The resolver reads R8's format (mapping version 2.x): class renames with their `sourceFile` metadata, method ranges `a:b:ret name(args):c:d -> x`, single-line (`:c`) and unranged entries, and inlined frames (several entries on one obfuscated range, innermost first, qualified names for methods inlined from another class). A frame expands to one row per inlined method, as a dSYM frame does. The exception classes of the first line and of the `Caused by:` and `Suppressed:` lines are retraced too. Not covered: outlines and `rewriteFrame` synthetic frames (rows are kept as R8 recorded them), field names, and a frame that matches several originals with different names (left `unmapped` rather than guessed).

## 3. Rejected

- **Deterministic id from the mapping's hash.** Needs the asset written after R8, which means rewriting the APK; Sentry and Bugsnag both chose a random id for this reason.
- **Keying by `service.version`.** Two variants (or a rebuilt store version) share a version; a wrong mapping retraces to plausible but false lines, which is worse than none.
- **Running R8's own `retrace` (Java).** A JVM in the plugin backend; the format is small enough to parse in Go.

## 4. Consequences

- Apps add one line to `app/build.gradle(.kts)` and one CI step. The React Native SDK's Android side compiles the same `Signals` sources and gets the attribute without changes on the app side beyond the Gradle line.
- Each build has its own id, so a rebuild of the same commit needs its own upload; CI that uploads after every release build already does.
- The founder decides open items O1 and O2 below.

## 5. Open

| # | Question | Default if not answered |
|---|---|---|
| O1 | Ship the Gradle step as a script to `apply from:` (this ADR) or as a published Gradle plugin (`dev.ouo.mapping`) | The script; a plugin when the native Android package is published |
| O2 | R8 8.12 already writes its own map hash into every minified frame's file name (`r8-map-id-<sha256>`, also `# pg_map_id` in the mapping). Key mappings by that hash instead, and drop the Gradle step? It is absent when an app keeps or renames the source file attribute, and on older R8 | Keep the Gradle id; read the hash later as a fallback when the attribute is missing |
