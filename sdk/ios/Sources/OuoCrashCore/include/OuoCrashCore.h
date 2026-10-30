// Native crash capture for ouo (checklist G1). Async-signal-safe C: the signal handler writes one
// JSON report to disk at crash time, the next launch sends it (OuoCrash, Swift). Report format and
// rationale: project/kb/ios-native-crashes.md.
#ifndef OUO_CRASH_CORE_H
#define OUO_CRASH_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Installs handlers for SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGSYS and SIGTRAP and starts
/// tracking loaded binary images. The handlers that were installed before (another crash reporter
/// such as Sentry, or the default action) are kept and called after the report is written.
/// `report_path` is copied. A second call only updates the path. Returns false when a handler could
/// not be installed (the others stay installed).
bool ouo_crash_install(const char *report_path);

/// Restores the previous handlers (tests). Images stay tracked.
void ouo_crash_uninstall(void);

bool ouo_crash_is_installed(void);

/// Gives the calling thread an alternate signal stack, so a stack overflow on it can still be
/// reported. Keeps an existing one (Sentry installs its own on the threads it owns).
void ouo_crash_install_alt_stack(void);

/// The session the next crash belongs to (id copied, at most 127 bytes) and when it started (epoch
/// ms, 0 when unknown). The report carries both, so a crash before the session's start was
/// exported still shows the session from its start (N52).
void ouo_crash_set_session(const char *session_id, int64_t started_ms);

/// Writes a report for an uncaught Objective-C exception (called from the NSException handler, not
/// from a signal). The SIGABRT that follows is then not reported again. `addresses` are the
/// exception's return addresses (`callStackReturnAddresses`).
void ouo_crash_record_exception(const char *name, const char *reason, const uintptr_t *addresses, size_t count, bool main_thread);

/// A binary image as the report lists it (Sentry `debug_meta` fields).
typedef struct {
    uintptr_t image_addr;
    uint64_t image_size;
    uint64_t image_vmaddr;
    const char *code_file;  // stable for the life of the image; may be NULL
    uint8_t uuid[16];
    bool has_uuid;
} ouo_crash_image_info;

/// The tracked binary image that contains `addr`. Tracks images from the first call (as install does).
bool ouo_crash_image_for(uintptr_t addr, ouo_crash_image_info *out);

/// Return addresses of the main thread, read from another thread (the app hang watchdog): the
/// main thread is suspended while its registers and frame-pointer chain are read, then resumed.
/// Writes at most `max` addresses (pc first, PAC stripped) and returns how many. Not for the
/// main thread itself (returns 0).
int ouo_crash_main_thread_backtrace(uintptr_t *out, int max);

/// Number of binary images tracked (tests).
int ouo_crash_image_count(void);

#ifdef __cplusplus
}
#endif

#endif
