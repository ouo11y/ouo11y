# iOS app hangs and foreground terminations (W4, 2026-10-30)

How `sdk/ios` reports the two failures no crash handler sees (mobile SDK spec C3), what the
rules are copied from, and what the simulator showed. Code: `OuoVitals/HangDetector.swift`
(rules, pure), `OuoVitals.startHangTracking` (watchdog thread), `OuoCrash/RunState.swift`
(`RunState`, `Termination.decide`, pure), `OuoCrash/RunTracker.swift` (the file writer),
`OuoCrash.startHangTracking` / `takePendingReport`, `ouo_crash_main_thread_backtrace` (C).
Verification: `project/agents/mobile-sdk/verify/w4-signals-sim.sh`.

## App hangs: sentry-cocoa's V2 rules on our display link

Read from `Sources/Swift/Integrations/AppHangTracking/SentryANRTrackerV2.swift` and
`Sources/Sentry/SentryDelayedFramesTracker.m` (sentry-cocoa main, 2026-10-30):

- A watchdog thread sleeps `timeout / 5` (400 ms) and asks for the **frame delay** of the last
  `timeout` (2 s): for every slow frame the part past the slow-frame threshold, overlapped with the
  window, plus the frame still awaited (from the last callback to now).
- Start: fully blocking when the delay is `>= timeout` and only the awaited frame contributes;
  not fully blocking when several frames contribute and the delay is `> 0.99 × timeout`. The 99 %
  is strict: 500 ms frames are not a hang (four on-time frame starts in 2 s already cost 68 ms),
  1.2 s frames are.
- Stop: the delay of the last `2 × timeout / 5` (800 ms) is below 20 % of that (160 ms).
- No new hang for `timeout` after one stopped; a tick that comes `timeout` late is skipped
  (Sentry) or, here, ends a hang in progress at the last tick that saw it and restarts measuring
  (the process was stopped, or ticks were skipped under a debugger).
- Sentry reports the duration as a range (`timeout + elapsed ± sleep interval`). ouo measures it
  from frames: from the start of the first late frame of the hang to the end of the last, so a
  3 s block reads 3.0 s, not 2.0 + whatever the ticks saw.

ouo's one change: `fully_blocking` is decided on the whole hang (one frame of `timeout` or more
in it), not at detection. On the simulator a 300 ms frame (the Cart screen rendering) right before
a 3 s block made the 99 % rule fire first, and the block was reported as "not fully blocking";
with the rule on the whole hang it is fully blocking, starting at the jank (3.1 s).

Why frames and not a ping to the main queue (Sentry's V1): a ping waits behind queued blocks and
cannot tell "stuck" from "busy but drawing"; the display link is already running for `app.jank`
(`OuoVitals`), so the hang detector is one more struct fed under the same lock (cost measured in
`FrameCostTests` on an M-series Mac: counter and detector together 94 ns per frame in a debug build, 11 ns optimized).

The **stack** is read at detection, while the main thread is still blocked:
`ouo_crash_main_thread_backtrace` suspends the main thread (its Mach port is remembered by an
image constructor, which runs on the main thread before `main`), reads `pc`, `lr`, `fp` with
`thread_get_state`, walks the frame-pointer chain with `vm_read_overwrite` (the crash handler's
walk) and resumes it; nothing else runs while it is suspended (no locks, no allocation). Images
come from the crash core's dyld list, so the `hang` report has the crash report's `frames` and
`images` and W7's dSYM symbolication reads it unchanged. `pthread_main_thread_np()` is not in
the iOS/macOS 27 SDK headers, hence the constructor.

Not measured: while the app is not active (between `willResignActive` and `didBecomeActive`;
the display link stops in the background), while a debugger is attached (`P_TRACED`; breakpoints
stop the main thread). A hang in progress when the app resigns active ends there.

## Foreground terminations: Sentry's watchdog-termination heuristic

`SIGKILL` (jetsam over the memory limit, the `0x8badf00d` watchdog, a user force-quit of a hung
app) runs no handler. The run keeps `Application Support/ouo/crash/run.json`:
`{release, os, bootMs, active, terminated, debugger, sessionId, sessionStartedMs, aliveMs,
hangStartedMs?, memoryWarningMs?}`, rewritten (atomic, a few hundred bytes, one utility queue) on
every app state change, session change, memory warning, hang start and end, and every 5 s while
active (the heartbeat that dates the death).

The next launch reads the file **once per process, before its own tracker writes** (a static per
directory) and removes it, so a launch that dies before writing its own state does not get the
same termination reported twice; then `takePendingReport` returns, in this order: the crash report if there is one
(the crash wins, and no termination follows it), else a `termination` report when
`Termination.decide` says so: the previous run was `active`, without `willTerminate`, `exit()`
(an `atexit` handler) or a debugger, with the same `CFBundleShortVersionString (CFBundleVersion)
<main executable LC_UUID>`, the same `major.minor.patch (kern.osversion)`, and a boot time within 5 s (`kern.boottime` moves a little with
clock corrections; a reboot moves it by at least the previous uptime).

Cause: `memory` when the run had a memory warning in its last 60 s (jetsam kills follow
warnings, and jetsam needs no main thread, so it wins over a hang), `watchdog` when a hang was in
progress, else `unknown`.

**Why not MetricKit for the cause.** `MXAppExitMetric` (foreground `memoryResourceLimit`,
`appWatchdog`, ... exit counts) comes in the daily `MXMetricPayload`, as counts for a day, not per
run. `MXCrashDiagnostic` (iOS 14+, immediate delivery from iOS 15) covers watchdog kills but not
jetsam, arrives asynchronously some time after a later launch, and names no run or session. The
termination has to be decided and stamped when the next launch starts, so neither can name its
cause; both are untestable on the simulator. A later package could attach diagnostics to the
session afterwards; nothing in the record would change.

## Simulator results (iPhone 18 Pro, iOS 27.0, Release build of examples/ouo-mobile)

`verify/w4-signals-sim.sh` drives the app through its journey mailbox and the demo-only chaos
module (`examples/ouo-mobile/modules/ouo-chaos`: a main-queue `Thread.sleep`; three 1.2 s blocks,
each next one started from a one-shot `CADisplayLink` so a frame is drawn between; a memory
warning followed by `kill(getpid(), SIGKILL)`). Final run:

- 3 s block on Cart: one `hang`, fully blocking, 3.07 s, stack `libsystem_kernel` >
  `libsystem_c` > `Foundation` (`Thread.sleep`) > `mobilestore` (the chaos module): symbolicatable.
  The first run reported it "not fully blocking": the 300 ms Cart render before it (see above).
- 3 x 1.2 s blocks: one `hang`, not fully blocking, 4.75 s. The Cart window's `app.jank` counts 4
  frozen frames (the 3 s block and the three 1.2 s blocks, so frames were drawn between them) and
  about 0.6 s of other slow-frame delay: the frames between the blocks were late too, which keeps
  the hang going (its end is the end of its last late frame). A 20 ms `asyncAfter` between the
  blocks did not reliably let a frame through (one run merged two blocks into a 2.4 s frame), hence
  the display link in the demo.
- Memory warning + SIGKILL on Chaos: next launch, `termination` with cause `memory`, screen
  `Chaos`, 14 last events; the session `crashed`, ended at the last heartbeat.
- `kill -9` while suspended in the background: no termination, session `terminated`, `healthy`.
- `simctl terminate` in the foreground: `termination`, cause `unknown`.
- TTFD on Products (reported when the catalog is on screen): 670 ms against a TTID of 637 ms; on
  later launches 17 to 33 ms after TTID, or equal when the catalog came before the first frame.
- `ouo.memory.available_bytes` is absent on the simulator: `os_proc_available_memory()` returns
  0 without a jetsam limit (a device has one). The footprint (`TASK_VM_INFO.phys_footprint`, about
  43 MB) and `network.connection.type` (`wifi`, from `NWPathMonitor`) are there.

## Review round 1 (PR #122): what the first version got wrong

- **A start without an end.** A late tick during a hang dropped it (`ongoing = nil`, no `.ended`),
  so `hangStartedMs` stayed in `run.json` and a later kill read as `watchdog`. And `onStart` runs on
  the watchdog thread after the detector's lock is released: the main thread's `willResignActive`
  could end the hang (`interrupt`, `onEnd`) before `onStart` ran, which then set
  `hangStartedMs` for a hang already over. Now every `.started` gets one `.ended` with the same
  `start` (a late tick ends it at the last tick that saw it), both callbacks carry the start, and
  `HangPairing` in OuoCrash ignores a start whose end came first. The run state is updated under
  OuoCrash's lock, so its writes keep the start-then-end order.
- **No measuring before the first frame.** `interrupt` (resign and become active) and a late tick
  set `lastFrame = nil`, and `tick` returns while it is nil: a block right after launch or resume,
  where `0x8badf00d` kills happen, was never a hang. Measuring now restarts at `now` there and when
  tracking starts (sentry-cocoa has the same gap: its delay is -1 until a frame comes).
- **Wakeups in the background.** The watchdog slept 400 ms and `continue`d while inactive; apps with
  background modes are not suspended, so it woke 2.5 times a second for nothing. It now waits on an
  `NSCondition` that `active = true` signals (tested on macOS: `HangWatchdogTests`).
- **Termination false positives**: `exit()` from app code (react-native-restart, a forced update)
  sends no `willTerminate` (an `atexit` handler now marks the run; tested by `OuoCrashProbe none`);
  a development reinstall keeps the version string (the main executable's `LC_UUID`, dyld image 0,
  is part of `release`); `operatingSystemVersionString` is localized (now
  `operatingSystemVersion` plus `kern.osversion`).
- **File protection**: an app whose default class is `NSFileProtectionComplete` could not read
  `run.json` in a background launch of a locked device but could delete it; it is written with
  `completeFileProtectionUntilFirstUserAuthentication`.
- **The stack of a fatal hang**: the stack read at detection now goes into `run.json`
  (`hangStack`, frames and images as JSON) and a `watchdog` termination carries it, as Sentry's
  fatal app hang does.
- **Simulator rerun** (new head): the 3 s block read 4.0 s once, with the machine loaded (load
  average 14 just after the env's image builds: slow frames before the block are part of the hang),
  and 3.08 s, fully blocking, on the next run; the stutter 3.75 s not fully blocking; the memory
  kill `memory`, its last event now the navigation to Chaos (persisted at once); the background
  kill `terminated`; the foreground kill `unknown`.

## npm in this worktree layout

`npx expo prebuild` (scripts/build-ios.sh) and the bench's `build.sh` fail in
`.claude/worktrees/*` with `call config.load() before reading values` (see
[ios-replay.md](ios-replay.md)). Wrappers on `PATH` that call the real npm with
`--prefix "$OUO_NPM_PREFIX"` (and `npx` as `npm exec --prefix "$OUO_NPM_PREFIX" --`) set to the
example's folder get both through; `ouo-env up` needs the plugin built the same way first
(`npm --prefix <worktree> run build -w plugins/ouo11y-rum-app`, then its
`dist/.ouo-env-built` marker holds `HEAD`).
