# iOS native crashes in the ouo React Native SDK (checklist G1, 2026-10-23)

Before: the RN SDK only saw JS fatals. A native crash (bad access, `abort()`, an uncaught
`NSException` in a native module) left no marker, so the next launch ended the session
`terminated` and it counted as healthy (project/kb/sentry-bridge-vs-ouo-sdk.md). Code: `sdk/ios`
targets `OuoCrashCore` (C) and `OuoCrash` (Swift), Expo module functions in
`sdk/react-native/ios/OuoReplayModule.swift`, JS in `sdk/react-native/src/crash.ts`.

## Flow

1. `initRUM` (unless `errors.nativeCrashes: false`) calls the Expo module:
   `takePendingCrash()` (the previous run's report, deleted on read: at most once, so a crash
   loop never resends), then `installCrashReporter(sessionId)`; every rotation calls
   `setCrashSessionId`.
2. At crash time the C handler builds JSON in a static buffer and writes
   `Library/Application Support/ouo/crash/report.json` (`.tmp` then `rename`, so a half-written
   file is never read).
3. Next launch: the report's `{sessionId, at: timestamp_ms}` is handed to the `SessionManager`
   as `nativeCrash`. When it names the persisted session, cold start ends that session with
   reason `crash` and `ouo.session.ended_at` = the crash time (it wins over the JS marker, which
   is written a flush earlier). After `ready`, a fatal `exception` (`ouo.exception.kind = native`)
   is emitted with the crashed `session.id`, the crash time as timestamp and the crashed
   session's `service.version`. ADR-0004 then classifies the session `crashed`.
4. `RCTFatalException: …` (React Native's Release-build abort after a JS fatal) only gives the end
   time: the JS global handler already emitted that error with its JS stack.

## Report format (version 1)

```json
{"version":1,"mechanism":"signal","timestamp_ms":1792700000000,"session_id":"…","arch":"arm64","pid":123,
 "thread":{"main":true},
 "signal":{"number":11,"name":"SIGSEGV","mach_exception":"EXC_BAD_ACCESS","code":1,"code_name":"SEGV_MAPERR","address":"0x0"},
 "frames":[{"instruction_addr":"0x104a1c2f0","image_addr":"0x104a00000"}],
 "images":[{"code_file":"/…/sentrydemo.app/sentrydemo","debug_id":"0A1B…","image_addr":"0x104a00000","image_size":4194304,"image_vmaddr":"0x100000000"}]}
```

`mechanism: "nsexception"` carries `exception: {name, reason}` instead of `signal`. Addresses are
hex strings (64-bit values). Image fields use Sentry's `debug_meta` names. Only images that a frame
points into are listed. On the OTel record: `exception.stacktrace` is Apple crash-report text
(`0   sentrydemo   0x0000000104a1c2f0 0x104a00000 + 115440` lines, then `Binary Images:`), and
`ouo.crash.frames` / `ouo.crash.images` keep the JSON for a symbolicator. rum-api symbolicates them
from uploaded dSYMs since W7 (2026-10-29, [dsym-symbolication.md](dsym-symbolication.md)). Manual symbolication:
`atos -arch arm64 -o App.app.dSYM/Contents/Resources/DWARF/App -l <image_addr> <instruction_addr>`.

## Async-signal safety (what the handler may do)

- No malloc, locks, Objective-C or Swift in the signal path. Formatting is hand-written
  (`w_hex`, `w_uint`, JSON escaping) into a 192 KB static buffer; `open`/`write`/`rename`/
  `clock_gettime` are async-signal-safe.
- **Binary images** are collected beforehand by `_dyld_register_func_for_add_image` (called for
  every image already loaded, then for each later `dlopen`) into a fixed array of 4096: load
  address, `__TEXT` size and vmaddr, `LC_UUID`, path (`LC_ID_DYLIB`, or `dladdr` for the
  executable). The handler only reads that array. dyld APIs take locks and are not safe there.
- **Stack**: the crashed thread only. `pc`, then the link register when it differs from the first
  frame-pointer return address (a leaf function pushes no frame, so its caller is only in `lr`),
  then the frame-pointer chain (`[fp]` = caller's fp, `[fp+8]` = return address). Every read goes
  through `vm_read_overwrite`, so a corrupt chain ends the walk instead of faulting again.
  Stops when fp does not grow (the stack grows down).
- **PAC**: system frameworks on device are arm64e and their saved return addresses carry a pointer
  authentication code. Mask with `0x0000000fffffffff` (KSCrash's mask). `ptrauth_strip` is a no-op in
  an arm64 (not arm64e) build, which apps are.
- Register access: `__darwin_arm_thread_state64_get_pc/lr/fp` (the fields are opaque under
  arm64e ptrauth headers; the macros work for both).
- **Alternate stack**: `sigaltstack` is per thread. `OuoCrash.install` sets one on the main thread
  (64 KB) only if none exists, so it does not replace Sentry's.
- First crashing thread wins (`atomic_flag`); other threads only chain.

## Next to Sentry (project/kb/ouo-next-to-sentry.md)

- `sigaction` returns the previous handler; ouo keeps it. After writing, ouo restores **all**
  previous handlers and calls the previous one for this signal (`sa_sigaction` with the same
  `siginfo`/context, or `sa_handler`). For `SIG_DFL` it `raise`s: the signal stays pending while
  the handler runs and the default action ends the process when it returns. `SIG_IGN` becomes
  `SIG_DFL` (an ignored fault would loop).
- Sentry installed after ouo: Sentry's KSCrash handler restores its previous handler (ouo's) and
  re-raises, so ouo's runs next. Installed before ouo (the README order): ouo runs first and calls
  Sentry's. Either way both write their report.
- `NSSetUncaughtExceptionHandler`: ouo keeps `NSGetUncaughtExceptionHandler()` and calls it after
  writing. A second `install` does not chain ouo to itself.
- After an `NSException` the runtime calls `abort()`: ouo's SIGABRT handler then writes nothing
  (the exception report stays) but still chains.
- Sentry also catches Mach exceptions (`EXC_BAD_ACCESS` reaches the Mach port before it becomes
  a signal). It records, then lets the kernel deliver the signal, which reaches the signal handlers.

## Verified

- macOS, `sdk/ios`: `OuoCrashTests` crash the `OuoCrashProbe` executable for SIGSEGV, abort,
  Swift trap, an uncaught NSException (name/reason escaping, one report), no crash. A "previous"
  signal and exception handler installed before ouo (standing in for Sentry) still run.
- JS: `test/crash.test.ts` (format, attributes, end-to-end relaunch against a stubbed OTLP endpoint).
- Simulator (2026-10-23, `project/agents/ios-replay/perf/crash-flow.sh`): native crash with Sentry + ouo,
  ouo only, and a JS fatal; sessions `crashed` at the crash time in rum-api; the Grafana plugin (0.8.0)
  shows the fatal error with "Show stack trace" and the native frames. Device: pending.

## Limits

- Only the crashed thread. No other threads' stacks, no registers in the report.
- Crashes before `initRUM` runs (native start-up, before the JS bundle) are not captured.
- A crash after the session ended lazily (inactivity) and before the next activity is attributed
  to the ended session.
- Watchdog kills (`0x8badf00d`), jetsam/OOM and `SIGKILL` cannot be caught by any in-process
  handler. Those need MetricKit (`MXCrashDiagnostic`), which arrives on a later launch.
- C++ exceptions are seen as the `SIGABRT` from `std::terminate`, without the exception type.
