# B1b: Android NDK crashes from `ApplicationExitInfo` tombstones

Date: 2026-11-04. Branch `claude/b1b-ndk`. JUHI gap list B1b: a C/C++ crash (Hermes, Fabric, a
third-party `.so`) on the React Native Android module was only a termination with cause `unknown`.

## What was done

- **`sdk/android/signals-core`**: `ProtoReader` (the protobuf wire format: varints, length-delimited
  fields, skipping; bounds-checked, no protobuf dependency), `Tombstone` (parses the Android 12+
  tombstone: arch, pid / tid, the local-time crash timestamp, the signal with code name and fault
  address, the abort message, debuggerd's cause, the crashing thread's name and frames with pc,
  rel_pc, file, build id and function+offset, and the images computed from the memory mappings),
  `NativeCrash.decide` (one exit, one record: the JVM crash file wins, then the tombstone, then the
  termination rule). `Report` gained the native fields; the JSON is the iOS `signal` report with
  `platform: android`, frames `instruction_addr` / `image_addr` (= pc - rel_pc) / `function` /
  `function_offset`, images with `code_id` (GNU build id) and `debug_id` (Sentry's GUID of it).
- **`sdk/android/signals` `Signals.init`**: reads the exit record's `getTraceInputStream()` for a
  `REASON_CRASH_NATIVE` exit on API 31+ (gzip-tolerant, at most 8 MB) and hands the native report out
  instead of the termination.
- **`sdk/react-native/src/crash.ts`**: Android `signal` reports get their own title
  (`SIGSEGV (SEGV_MAPERR) at 0x0: null pointer dereference`, `SIGABRT (SI_QUEUE): <abort message>`),
  stack lines show `(function+offset)`, the thread name, the library name after `base.apk!`, and the
  build id in Binary Images. No new attribute.
- **Example**: `modules/ouo-chaos` builds `libouochaos.so` (CMake, C) with `ouo_chaos_segv` (a store
  to address 0 through a volatile pointer) and `ouo_chaos_abort` (`android_set_abort_message` +
  `abort()`), called on the JS thread by `crashInNativeCode(abort)`; journey command
  `action/crash-ndk[?abort=1]`.
- **Suite**: `tests/e2e/mobile-android` runs two more launches and asserts the new check **C2.4**.
- **Docs**: mobile-sdk.md C2 (Android NDK bullet, C2.4), C3 Android rules, the matrix; ADR-0017
  addendum (no native signal handler on any API level, reasons, the follow-up for API 24–30); the
  READMEs of `sdk/android`, `sdk/react-native` and the suite; kb
  [android-ndk-tombstones.md](../../../kb/android-ndk-tombstones.md).

## Verified, and how

- Proto field numbers: a raw protobuf dump of a real tombstone (`kill -SEGV` of toybox `sleep`, API 35
  arm64 emulator, `adb root`) compared with its text twin; then the app's own SIGSEGV and abort tombstones.
- `sdk/android`: CI's command `./gradlew :replay-core:test :signals-core:test :replay:assembleRelease
  :signals:assembleRelease :replay:compileDebugAndroidTestKotlin`: green; signals-core 18 tests
  (10 `TombstoneTest`, against the three real tombstones, trimmed, and synthetic ones: abort message,
  APK-embedded library, anonymous frames, truncated / text / garbage input, timestamps with offsets,
  debug ids, every `NativeCrash.decide` case).
- `sdk/react-native`: vitest 213 pass (new: the Android NDK report's attributes, title and stack), `tsc
  --noEmit` clean; `examples/ouo-mobile` `tsc --noEmit` clean. `lychee --offline` on the changed docs: 0 errors.
- Emulator suite `tests/e2e/mobile-android/run.sh b1b-ndk emulator-5596` (own AVD `ouo-b1b`, API 35,
  env `b1b-ndk`): run 1 found the capture right and the check wrong (the note's `kind` was overwritten
  by a field named `kind`; fixed), run 2 C2.4 pass and C2.3 FAIL (the JVM crash 200 ms after launch came
  1.21 s after its note, a busy cold-start main thread; no B1b code runs in that launch), run 3 (same
  APK) **20/20, React Native Android L2 on C1–C11**. C2.4's records: `SIGSEGV (SEGV_MAPERR) at 0x0: null
  pointer dereference`, top frame `ouo_chaos_segv+12`, image `base.apk!libouochaos.so` 0x3000 bytes with
  build id `d98bdee3...`, one fatal record per exit, the session ended at the tombstone time (63 ms
  after the note); `SIGABRT (SI_QUEUE): ouo-mobile: native abort from the Chaos module`.

## Left, and what the next session must know

- **B3b**: symbolicate the frames with the unstripped `.so` by build id (`code_id`; the relative pc is
  `instruction_addr - image_addr`). rum-api tries dSYMs today and finds none for these images.
- **Below Android 12**: no capture (Android 11: termination `unknown`, 10 and older: nothing). A signal
  handler is a follow-up only if a client's device mix needs it (ADR-0017 addendum).
- npm fails in every worktree while the shared checkout has a workspace with a conflicted
  `package.json`: run npm with `--prefix <worktree root>` (scripts that call npm need a wrapper on PATH).
- No dependency added (the example's C library uses only the NDK).
