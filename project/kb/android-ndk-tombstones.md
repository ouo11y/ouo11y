# Android NDK crashes from `ApplicationExitInfo` tombstones (B1b, 2026-11-04)

How `sdk/android` reports a C/C++ crash (Hermes, Fabric, a third-party `.so`) of the previous run:
`signals-core` `Tombstone` / `NativeCrash` (pure Kotlin, tested on the JVM against a real API 35
tombstone), wired in `signals` `Signals.init`. Report format: the iOS `signal` report of
[ios-native-crashes.md](ios-native-crashes.md) with `platform: android`. Spec: mobile-sdk.md C2.

## Where the tombstone comes from

- A native crash runs debuggerd's handler (linked into every process by bionic): `crash_dump` ptraces
  the process, unwinds every thread with libunwindstack and hands the result to `tombstoned`, which
  writes `/data/tombstones/tombstone_NN` (text) and, since Android 12, `tombstone_NN.pb` (protobuf).
  system_server learns of the crash from debuggerd and records the exit as `REASON_CRASH_NATIVE`.
- `ActivityManager.getHistoricalProcessExitReasons(pkg, pid, 1)` at the next launch gives that exit;
  on Android 12+ (API 31) its `getTraceInputStream()` is **the protobuf tombstone** (not the text one,
  not gzip on the API 35 emulator; the code unpacks gzip anyway if the first bytes are `1f 8b`). On
  Android 11 the stream is null for native crashes (only ANRs have a trace): ouo then keeps the
  termination record with cause `unknown`.
- The app reads it without any permission; it is its own process's record.
- An exit that has no tombstone yet (the app relaunched before tombstoned linked it, or the system
  dropped it) has a null stream: the termination rule runs instead, so the session still ends.

## The protobuf (system/core/debuggerd/proto/tombstone.proto), as verified on API 35

Field numbers read (checked with a raw dump of `/data/tombstones/tombstone_00.pb` against the text tombstone):

| Message | Fields ouo reads |
|---|---|
| `Tombstone` | 1 `arch` (enum: 0 arm, 1 arm64, 2 x86, 3 x86_64, 4 riscv64), 4 `timestamp` (string), 5 `pid`, 6 `tid` (the crashing thread), 10 `signal_info`, 14 `abort_message`, 15 `causes` (repeated), 16 `threads` (map), 17 `memory_mappings` (repeated) |
| `Signal` | 1 `number`, 2 `name`, 3 `code`, 4 `code_name`, 8 `has_fault_address`, 9 `fault_address` |
| `Thread` | 1 `id`, 2 `name`, 4 `current_backtrace` (repeated `BacktraceFrame`) |
| `BacktraceFrame` | 1 `rel_pc`, 2 `pc`, 3 `sp`, 4 `function_name`, 5 `function_offset`, 6 `file_name`, 7 `file_map_offset`, 8 `build_id` (hex string) |
| `MemoryMapping` | 1 `begin_address`, 2 `end_address`, 3 `offset`, 7 `mapping_name`, 8 `build_id` |
| `Cause` | 1 `human_readable` (`null pointer dereference`, MTE / GWP-ASan diagnoses) |

Quirks:

- **proto3 drops defaults**: `code` 0 (`SI_USER`) is absent, `fault_address` is absent unless
  `has_fault_address` is true (a `kill -SEGV` has none; a real bad access at address 0 has
  `has_fault_address = 1` and no field 9, because 0 is the default: seen in the example's SIGSEGV).
  Read field 8 for "known".
- **`threads` is a `map<uint32, Thread>`**: on the wire, repeated entries `{1: key, 2: Thread}`. The
  crashing thread is the entry whose key (and `Thread.id`) is `tid`; `tid == pid` is the main thread.
  React Native's JS thread is named `mqt_v_js` / `mqt_js`.
- **`timestamp` is local time with an offset**: `2026-11-04 03:44:53.013775285+0200` (debuggerd's
  `%F %H:%M:%S.%09ld%z`). Parsed by hand (no `java.time`: minSdk 24).
- **The exit's timestamp is later than the crash**: debuggerd holds the process while it dumps (all
  threads, memory near registers, logcat), so `ApplicationExitInfo.timestamp` is when the process
  finally died: 209 ms after the tombstone's time for the example's SIGSEGV, 117 ms for its abort
  (API 35 emulator, about 70 threads; more on a busy device). ouo stamps the record at the tombstone's
  time when it is within the minute before the exit (else the exit's). `dumpsys activity exit-info`
  prints `trace=null` for these exits although `getTraceInputStream()` returns the tombstone.
- **`abort()` is `SIGABRT` with code `SI_QUEUE` (-1)** on API 35 (bionic's `abort` uses
  `rt_tgsigqueueinfo`), not `SI_TKILL`; the abort message is field 14, not part of the signal.
- **The crashing thread's backtrace includes interpreted and compiled Java frames**: `base.vdex`,
  `boot.oat` and `libart.so` (`nterp_helper`, `art_quick_generic_jni_trampoline`) frames whose
  `function_name` is the dex method (`expo.modules.kotlin.functions.SyncFunctionComponent.callUserImplementation`):
  the example's SIGSEGV has 65 frames, from `ouo_chaos_segv` down to `art_quick_invoke_stub` on
  `mqt_v_js` (React Native's JS thread). ouo keeps the first 100.
- **`rel_pc` is the address in the ELF's own address space** (what `llvm-symbolizer --obj=libfoo.so
  0x<rel_pc>` reads); `pc - rel_pc` is the ELF's load base, the same for every frame of one file. ouo
  writes it as the frame's `image_addr` and the image's, with `image_vmaddr` `0x0`, so
  `instruction_addr - image_addr` is the relative pc, as on iOS.
- **Libraries loaded from inside the APK** (AGP's default, uncompressed `.so` in the APK) are named
  `.../base.apk!libfoo.so` in the frames, while their mappings are named `.../base.apk`: the image size
  is computed from the mappings named before the `!` (the run of them starting at the load base).
- **Anonymous frames** (JIT code, `[anon:dalvik-jit-code-cache]`, a corrupt pc) have no file or a
  `[anon:...]` name: written with the absolute pc only, no image.
- **`function_name`** comes from the ELF's symbol tables on the device (`.dynsym`, and `.symtab` /
  `.gnu_debugdata` when present): exported functions of a stripped release `.so` are named, static
  ones are not. Symbolicating with the unstripped `.so` (by build id) is B3b.
- **Build ids**: `build_id` is the GNU build id as hex (16 bytes for LLD's default fast hash, 20 for
  `--build-id=sha1`). Sentry's ELF `debug_id` is its first 16 bytes as a GUID with the first three
  fields byte-swapped (`1b9fecf8 34d6 10f7 ...` → `f8ec9f1b-d634-f710-...`); ouo sends both
  (`code_id`, `debug_id`).
- **Size**: the toybox tombstone is 17 KB; the example app's are 375–379 KB (every thread, memory
  near registers, 700 mappings, logcat). ouo reads at most 8 MB and skips every field it does not use.
- **Libraries inside the APK** map a few pages each at offsets into `base.apk` (`libouochaos.so`:
  three 4 KB mappings at APK offset `0xecc000`, `file_map_offset` in the frame), and the next mapping
  belongs to another file, which ends the image's run.
- Fixtures: an emulator with `adb root` (google_apis images) keeps them in `/data/tombstones/`; any
  native process can be crashed with `adb shell 'sleep 60 & p=$!; sleep 1; kill -SEGV $p'`. The app
  fixtures in `signals-core/src/test/resources/tombstones/` were trimmed to about 22 KB (other
  threads, memory dumps, logcat and fds dropped; the frames' files' mappings and the one after each
  kept) by re-encoding the top-level fields byte for byte.

## One exit, one record

`Signals.init`: the JVM crash file wins (an uncaught Java exception that later aborts natively is
still the Java crash), then `NativeCrash.decide` (the exit is the previous run's pid, its reason is
`REASON_CRASH_NATIVE`, the tombstone parses and names the same pid), then the termination rule with
`crashReported = true` when the native report exists. Read once at init and handed out once
(`takePendingReport`), and `run.json` names the new pid at once, so a relaunch never re-reports.
A native crash in the background is reported as a crash (a JVM crash there is too); only the
termination heuristic is limited to foreground deaths.

## No signal handler (ADR-0017 addendum)

ouo does not install a native signal handler on Android: on 12+ the system's dump is complete, and
chaining with Crashlytics / Sentry / ART's fault handler (libsigchain) safely needs more than iOS's
`sigaction` dance. Below 12: Android 11 sends a termination with cause `unknown`, 10 and older nothing.

## Verified

See the agent summary of this change (`project/agents/mobile-sdk/summaries/`) and the C2.4 run.
