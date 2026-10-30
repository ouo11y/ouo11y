// Native crash capture (checklist G1). Everything reachable from `handle_signal` is
// async-signal-safe: no malloc, no locks, no Objective-C or Swift. Memory is read through
// vm_read_overwrite so a corrupt frame pointer cannot fault inside the handler, and the report is
// built in a static buffer and written with open/write/rename.

#include "OuoCrashCore.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach/mach.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ucontext.h>
#include <time.h>
#include <unistd.h>

#define OUO_MAX_FRAMES 128
#define OUO_MAX_IMAGES 4096
#define OUO_PATH_MAX 1024
#define OUO_SESSION_MAX 128
#define OUO_BUF_SIZE (192 * 1024)
#define OUO_ALT_STACK_SIZE (64 * 1024)

static const int kSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGSYS, SIGTRAP};
#define OUO_SIGNAL_COUNT ((int)(sizeof(kSignals) / sizeof(kSignals[0])))

static struct sigaction g_previous[OUO_SIGNAL_COUNT];
static atomic_bool g_installed = false;
static char g_path[OUO_PATH_MAX];
static char g_tmp_path[OUO_PATH_MAX + 8];

// Two buffers: the writer fills the one not in use, then publishes its index.
typedef struct {
    char id[OUO_SESSION_MAX];
    int64_t started_ms;
} ouo_session;
static ouo_session g_session[2];
static atomic_int g_session_index = 0;

// First crashing thread writes; any other thread (or a second signal) only chains.
static atomic_flag g_handling = ATOMIC_FLAG_INIT;
static atomic_bool g_exception_recorded = false;

typedef struct {
    uintptr_t start;   // load address (mach header)
    uintptr_t end;     // start + __TEXT vmsize
    uint64_t vmaddr;   // __TEXT vmaddr in the file, for symbolication
    const char *name;  // stable for the life of the image
    uint8_t uuid[16];
    bool has_uuid;
} ouo_image;

static ouo_image g_images[OUO_MAX_IMAGES];
static atomic_int g_image_count = 0;
static bool g_image_used[OUO_MAX_IMAGES];

// ---- binary images (normal context: dyld callback) ----

static void on_add_image(const struct mach_header *mh, intptr_t slide) {
    (void)slide;
    if (mh == NULL || mh->magic != MH_MAGIC_64) return;
    int slot = atomic_load(&g_image_count);
    if (slot >= OUO_MAX_IMAGES) return;
    ouo_image img;
    memset(&img, 0, sizeof(img));
    img.start = (uintptr_t)mh;
    const struct mach_header_64 *h = (const struct mach_header_64 *)mh;
    uintptr_t cmd = (uintptr_t)(h + 1);
    for (uint32_t i = 0; i < h->ncmds; i++) {
        const struct load_command *lc = (const struct load_command *)cmd;
        if (lc->cmd == LC_SEGMENT_64) {
            const struct segment_command_64 *seg = (const struct segment_command_64 *)lc;
            if (strncmp(seg->segname, "__TEXT", sizeof(seg->segname)) == 0) {
                img.vmaddr = seg->vmaddr;
                img.end = img.start + (uintptr_t)seg->vmsize;
            }
        } else if (lc->cmd == LC_UUID) {
            memcpy(img.uuid, ((const struct uuid_command *)lc)->uuid, 16);
            img.has_uuid = true;
        } else if (lc->cmd == LC_ID_DYLIB) {
            const struct dylib_command *d = (const struct dylib_command *)lc;
            img.name = (const char *)lc + d->dylib.name.offset;
        }
        cmd += lc->cmdsize;
    }
    if (img.name == NULL) {
        // The executable and bundles have no LC_ID_DYLIB.
        Dl_info info;
        if (dladdr(mh, &info) != 0) img.name = info.dli_fname;
    }
    g_images[slot] = img;
    // dyld runs add-image callbacks one at a time; publishing the count makes the slot visible.
    atomic_store(&g_image_count, slot + 1);
}

int ouo_crash_image_count(void) { return atomic_load(&g_image_count); }

static int image_for(uintptr_t addr) {
    int n = atomic_load(&g_image_count);
    for (int i = 0; i < n; i++) {
        if (addr >= g_images[i].start && addr < g_images[i].end) return i;
    }
    return -1;
}

// ---- report writer (async-signal-safe) ----

static char g_buf[OUO_BUF_SIZE];
static size_t g_len;

static void w_raw(const char *s, size_t n) {
    if (g_len + n >= OUO_BUF_SIZE) n = OUO_BUF_SIZE - 1 - g_len;
    memcpy(g_buf + g_len, s, n);
    g_len += n;
}

static void w(const char *s) { w_raw(s, strlen(s)); }

static void w_char(char c) { w_raw(&c, 1); }

/// JSON string with escapes; non-ASCII UTF-8 bytes pass through.
static void w_str(const char *s) {
    static const char hex[] = "0123456789abcdef";
    w_char('"');
    if (s != NULL) {
        for (const unsigned char *p = (const unsigned char *)s; *p != 0 && g_len < OUO_BUF_SIZE - 8; p++) {
            unsigned char c = *p;
            if (c == '"' || c == '\\') {
                w_char('\\');
                w_char((char)c);
            } else if (c == '\n') {
                w("\\n");
            } else if (c == '\t') {
                w("\\t");
            } else if (c < 0x20) {
                char e[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 0xf]};
                w_raw(e, 6);
            } else {
                w_char((char)c);
            }
        }
    }
    w_char('"');
}

static void w_uint(uint64_t v) {
    char tmp[24];
    int i = 0;
    do {
        tmp[i++] = (char)('0' + v % 10);
        v /= 10;
    } while (v != 0);
    while (i > 0) w_char(tmp[--i]);
}

static void w_int(int64_t v) {
    if (v < 0) {
        w_char('-');
        w_uint((uint64_t)(-(v + 1)) + 1);
    } else {
        w_uint((uint64_t)v);
    }
}

/// "0x..." lowercase, as a JSON string (addresses exceed JavaScript's safe integers on some hosts).
static void w_hex(uint64_t v) {
    static const char hex[] = "0123456789abcdef";
    char tmp[20];
    int i = 0;
    do {
        tmp[i++] = hex[v & 0xf];
        v >>= 4;
    } while (v != 0);
    w("\"0x");
    while (i > 0) w_char(tmp[--i]);
    w_char('"');
}

static void w_uuid(const uint8_t *u) {
    static const char hex[] = "0123456789ABCDEF";
    w_char('"');
    for (int i = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) w_char('-');
        w_char(hex[u[i] >> 4]);
        w_char(hex[u[i] & 0xf]);
    }
    w_char('"');
}

static const char *signal_name(int sig) {
    switch (sig) {
        case SIGABRT: return "SIGABRT";
        case SIGBUS: return "SIGBUS";
        case SIGFPE: return "SIGFPE";
        case SIGILL: return "SIGILL";
        case SIGSEGV: return "SIGSEGV";
        case SIGSYS: return "SIGSYS";
        case SIGTRAP: return "SIGTRAP";
        default: return "UNKNOWN";
    }
}

/// The Mach exception the kernel turned into this signal, as Apple's crash reports name it.
static const char *mach_exception_name(int sig) {
    switch (sig) {
        case SIGSEGV:
        case SIGBUS: return "EXC_BAD_ACCESS";
        case SIGILL: return "EXC_BAD_INSTRUCTION";
        case SIGFPE: return "EXC_ARITHMETIC";
        case SIGTRAP: return "EXC_BREAKPOINT";
        case SIGABRT: return "EXC_CRASH";
        default: return "EXC_CRASH";
    }
}

static const char *code_name(int sig, int code) {
    if (sig == SIGSEGV) {
        if (code == SEGV_MAPERR) return "SEGV_MAPERR";
        if (code == SEGV_ACCERR) return "SEGV_ACCERR";
    } else if (sig == SIGBUS) {
        if (code == BUS_ADRALN) return "BUS_ADRALN";
        if (code == BUS_ADRERR) return "BUS_ADRERR";
        if (code == BUS_OBJERR) return "BUS_OBJERR";
    } else if (sig == SIGFPE) {
        if (code == FPE_INTDIV) return "FPE_INTDIV";
        if (code == FPE_FLTDIV) return "FPE_FLTDIV";
    } else if (sig == SIGILL) {
        if (code == ILL_ILLOPC) return "ILL_ILLOPC";
    }
    return NULL;
}

static uint64_t now_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return 0;
    return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

static uintptr_t strip_pac(uintptr_t a) {
#if defined(__arm64__) || defined(__aarch64__)
    // System frameworks are arm64e: saved return addresses carry a pointer authentication code.
    return a & 0x0000000fffffffffULL;
#else
    return a;
#endif
}

static bool safe_read(uintptr_t addr, void *dst, size_t len) {
    vm_size_t out = 0;
    kern_return_t kr = vm_read_overwrite(mach_task_self(), (vm_address_t)addr, (vm_size_t)len, (vm_address_t)dst, &out);
    return kr == KERN_SUCCESS && out == len;
}

static const char *arch_name(void) {
#if defined(__arm64e__)
    return "arm64e";
#elif defined(__arm64__) || defined(__aarch64__)
    return "arm64";
#elif defined(__x86_64__)
    return "x86_64";
#else
    return "unknown";
#endif
}

/// Writes `"frames":[...],"images":[...]` for the given addresses.
static void w_frames_and_images(const uintptr_t *frames, int n) {
    int image_count = atomic_load(&g_image_count);
    for (int i = 0; i < image_count; i++) g_image_used[i] = false;
    w("\"frames\":[");
    for (int i = 0; i < n; i++) {
        if (i > 0) w_char(',');
        w("{\"instruction_addr\":");
        w_hex(frames[i]);
        int img = image_for(frames[i]);
        if (img >= 0) {
            g_image_used[img] = true;
            w(",\"image_addr\":");
            w_hex(g_images[img].start);
        }
        w_char('}');
    }
    w("],\"images\":[");
    bool first = true;
    for (int i = 0; i < image_count; i++) {
        if (!g_image_used[i]) continue;
        if (!first) w_char(',');
        first = false;
        const ouo_image *im = &g_images[i];
        w("{\"code_file\":");
        w_str(im->name != NULL ? im->name : "");
        if (im->has_uuid) {
            w(",\"debug_id\":");
            w_uuid(im->uuid);
        }
        w(",\"image_addr\":");
        w_hex(im->start);
        w(",\"image_size\":");
        w_uint(im->end - im->start);
        w(",\"image_vmaddr\":");
        w_hex(im->vmaddr);
        w_char('}');
    }
    w_char(']');
}

static void w_header(const char *mechanism, bool main_thread) {
    g_len = 0;
    w("{\"version\":1,\"mechanism\":");
    w_str(mechanism);
    w(",\"timestamp_ms\":");
    w_uint(now_ms());
    const ouo_session *session = &g_session[atomic_load(&g_session_index)];
    w(",\"session_id\":");
    w_str(session->id);
    if (session->started_ms > 0) {
        w(",\"session_started_ms\":");
        w_int(session->started_ms);
    }
    w(",\"arch\":");
    w_str(arch_name());
    w(",\"pid\":");
    w_int(getpid());
    w(",\"thread\":{\"main\":");
    w(main_thread ? "true" : "false");
    w("},");
}

static void flush_report(void) {
    if (g_path[0] == 0) return;
    int fd = open(g_tmp_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return;
    size_t off = 0;
    while (off < g_len) {
        ssize_t n = write(fd, g_buf + off, g_len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        off += (size_t)n;
    }
    close(fd);
    // Whole file or nothing: the next launch never reads a half-written report.
    if (off == g_len) rename(g_tmp_path, g_path);
}

static void write_signal_report(int sig, siginfo_t *info, ucontext_t *uc) {
    uintptr_t frames[OUO_MAX_FRAMES];
    int n = 0;
    uintptr_t pc = 0, lr = 0, fp = 0;
    if (uc != NULL && uc->uc_mcontext != NULL) {
#if defined(__arm64__) || defined(__aarch64__)
        pc = (uintptr_t)__darwin_arm_thread_state64_get_pc(uc->uc_mcontext->__ss);
        lr = (uintptr_t)__darwin_arm_thread_state64_get_lr(uc->uc_mcontext->__ss);
        fp = (uintptr_t)__darwin_arm_thread_state64_get_fp(uc->uc_mcontext->__ss);
#elif defined(__x86_64__)
        pc = (uintptr_t)uc->uc_mcontext->__ss.__rip;
        fp = (uintptr_t)uc->uc_mcontext->__ss.__rbp;
#endif
    }
    pc = strip_pac(pc);
    lr = strip_pac(lr);
    if (pc != 0) frames[n++] = pc;

    // Frame-pointer chain: [fp] = caller's fp, [fp + 8] = return address (arm64 and x86_64 ABIs).
    uintptr_t walked[OUO_MAX_FRAMES];
    int wn = 0;
    uintptr_t cur = fp;
    while (cur != 0 && (cur & 0x7) == 0 && wn < OUO_MAX_FRAMES) {
        uintptr_t pair[2];
        if (!safe_read(cur, pair, sizeof(pair))) break;
        uintptr_t ret = strip_pac(pair[1]);
        if (ret == 0) break;
        walked[wn++] = ret;
        if (pair[0] <= cur) break;  // the stack grows down: callers live at higher addresses
        cur = pair[0];
    }
    // A leaf function does not push a frame: its caller is only in the link register.
    if (lr != 0 && (wn == 0 || walked[0] != lr) && n < OUO_MAX_FRAMES) frames[n++] = lr;
    for (int i = 0; i < wn && n < OUO_MAX_FRAMES; i++) frames[n++] = walked[i];

    w_header("signal", pthread_main_np() != 0);
    w("\"signal\":{\"number\":");
    w_int(sig);
    w(",\"name\":");
    w_str(signal_name(sig));
    w(",\"mach_exception\":");
    w_str(mach_exception_name(sig));
    if (info != NULL) {
        w(",\"code\":");
        w_int(info->si_code);
        const char *cn = code_name(sig, info->si_code);
        if (cn != NULL) {
            w(",\"code_name\":");
            w_str(cn);
        }
        w(",\"address\":");
        w_hex((uint64_t)(uintptr_t)info->si_addr);
    }
    w("},");
    w_frames_and_images(frames, n);
    w_char('}');
    flush_report();
}

static int signal_index(int sig) {
    for (int i = 0; i < OUO_SIGNAL_COUNT; i++) {
        if (kSignals[i] == sig) return i;
    }
    return -1;
}

static void restore_previous(void) {
    for (int i = 0; i < OUO_SIGNAL_COUNT; i++) sigaction(kSignals[i], &g_previous[i], NULL);
}

static void handle_signal(int sig, siginfo_t *info, void *uap) {
    if (!atomic_flag_test_and_set(&g_handling) && !atomic_load(&g_exception_recorded)) {
        write_signal_report(sig, info, (ucontext_t *)uap);
    }
    // Hand the signal on exactly as if ouo had never been installed: the previous handlers come
    // back (so a re-raise or a re-executed fault reaches them), then the previous one for this
    // signal runs. Sentry's handler records its own report and re-raises; the default action ends
    // the process.
    int idx = signal_index(sig);
    restore_previous();
    atomic_store(&g_installed, false);
    if (idx < 0) {
        raise(sig);
        return;
    }
    const struct sigaction *prev = &g_previous[idx];
    if ((prev->sa_flags & SA_SIGINFO) != 0 && prev->sa_sigaction != NULL) {
        prev->sa_sigaction(sig, info, uap);
        return;
    }
    if (prev->sa_handler == SIG_IGN) {
        // An ignored fault would re-execute forever: use the default action instead.
        signal(sig, SIG_DFL);
        raise(sig);
        return;
    }
    if (prev->sa_handler == SIG_DFL) {
        // Pending until this handler returns (the signal is masked meanwhile), then the default
        // action ends the process. A hardware fault would also re-execute and fault again.
        raise(sig);
        return;
    }
    prev->sa_handler(sig);
}

// ---- public API (normal context) ----

static pthread_once_t g_images_once = PTHREAD_ONCE_INIT;

static void register_images(void) {
    // Called right away for every image already loaded, then for each later dlopen.
    _dyld_register_func_for_add_image(on_add_image);
}

static void track_images(void) { pthread_once(&g_images_once, register_images); }

bool ouo_crash_image_for(uintptr_t addr, ouo_crash_image_info *out) {
    track_images();
    int i = image_for(addr);
    if (i < 0 || out == NULL) return false;
    const ouo_image *im = &g_images[i];
    out->image_addr = im->start;
    out->image_size = im->end - im->start;
    out->image_vmaddr = im->vmaddr;
    out->code_file = im->name;
    memcpy(out->uuid, im->uuid, 16);
    out->has_uuid = im->has_uuid;
    return true;
}

// Image constructors run on the main thread, before `main`.
static thread_t g_main_thread = MACH_PORT_NULL;
__attribute__((constructor)) static void remember_main_thread(void) { g_main_thread = pthread_mach_thread_np(pthread_self()); }

int ouo_crash_main_thread_backtrace(uintptr_t *out, int max) {
    thread_t main = g_main_thread;
    if (out == NULL || max <= 0 || main == MACH_PORT_NULL || pthread_main_np() != 0) return 0;
    uintptr_t pc = 0, lr = 0, fp = 0;
    if (thread_suspend(main) != KERN_SUCCESS) return 0;
#if defined(__arm64__) || defined(__aarch64__)
    arm_thread_state64_t st;
    mach_msg_type_number_t count = ARM_THREAD_STATE64_COUNT;
    if (thread_get_state(main, ARM_THREAD_STATE64, (thread_state_t)&st, &count) == KERN_SUCCESS) {
        pc = (uintptr_t)__darwin_arm_thread_state64_get_pc(st);
        lr = (uintptr_t)__darwin_arm_thread_state64_get_lr(st);
        fp = (uintptr_t)__darwin_arm_thread_state64_get_fp(st);
    }
#elif defined(__x86_64__)
    x86_thread_state64_t st;
    mach_msg_type_number_t count = x86_THREAD_STATE64_COUNT;
    if (thread_get_state(main, x86_THREAD_STATE64, (thread_state_t)&st, &count) == KERN_SUCCESS) {
        pc = (uintptr_t)st.__rip;
        fp = (uintptr_t)st.__rbp;
    }
#endif
    // The same walk as the crash report, while the thread cannot change its stack.
    int n = 0;
    pc = strip_pac(pc);
    lr = strip_pac(lr);
    if (pc != 0) out[n++] = pc;
    uintptr_t walked[OUO_MAX_FRAMES];
    int wn = 0;
    uintptr_t cur = fp;
    while (cur != 0 && (cur & 0x7) == 0 && wn < OUO_MAX_FRAMES) {
        uintptr_t pair[2];
        if (!safe_read(cur, pair, sizeof(pair))) break;
        uintptr_t ret = strip_pac(pair[1]);
        if (ret == 0) break;
        walked[wn++] = ret;
        if (pair[0] <= cur) break;
        cur = pair[0];
    }
    thread_resume(main);
    if (lr != 0 && (wn == 0 || walked[0] != lr) && n < max) out[n++] = lr;
    for (int i = 0; i < wn && n < max; i++) out[n++] = walked[i];
    return n;
}

bool ouo_crash_install(const char *report_path) {
    if (report_path != NULL) {
        size_t n = strlen(report_path);
        if (n >= OUO_PATH_MAX) n = OUO_PATH_MAX - 1;
        memcpy(g_path, report_path, n);
        g_path[n] = 0;
        memcpy(g_tmp_path, g_path, n);
        memcpy(g_tmp_path + n, ".tmp", 5);
    }
    track_images();
    if (atomic_load(&g_installed)) return true;
    bool ok = true;
    for (int i = 0; i < OUO_SIGNAL_COUNT; i++) {
        struct sigaction sa;
        memset(&sa, 0, sizeof(sa));
        sa.sa_sigaction = handle_signal;
        sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
        sigemptyset(&sa.sa_mask);
        if (sigaction(kSignals[i], &sa, &g_previous[i]) != 0) {
            ok = false;
            memset(&g_previous[i], 0, sizeof(g_previous[i]));
            g_previous[i].sa_handler = SIG_DFL;
        }
    }
    atomic_flag_clear(&g_handling);
    atomic_store(&g_exception_recorded, false);
    atomic_store(&g_installed, true);
    return ok;
}

void ouo_crash_uninstall(void) {
    if (!atomic_load(&g_installed)) return;
    for (int i = 0; i < OUO_SIGNAL_COUNT; i++) {
        struct sigaction cur;
        // Only put the previous handler back if nobody replaced ours since.
        if (sigaction(kSignals[i], NULL, &cur) == 0 && (cur.sa_flags & SA_SIGINFO) != 0 && cur.sa_sigaction == handle_signal) {
            sigaction(kSignals[i], &g_previous[i], NULL);
        }
    }
    atomic_store(&g_installed, false);
}

bool ouo_crash_is_installed(void) { return atomic_load(&g_installed); }

void ouo_crash_install_alt_stack(void) {
    stack_t current;
    if (sigaltstack(NULL, &current) == 0 && (current.ss_flags & SS_DISABLE) == 0) return;
    stack_t st;
    st.ss_sp = malloc(OUO_ALT_STACK_SIZE);
    if (st.ss_sp == NULL) return;
    st.ss_size = OUO_ALT_STACK_SIZE;
    st.ss_flags = 0;
    if (sigaltstack(&st, NULL) != 0) free(st.ss_sp);
}

void ouo_crash_set_session(const char *session_id, int64_t started_ms) {
    int next = 1 - atomic_load(&g_session_index);
    size_t n = session_id != NULL ? strlen(session_id) : 0;
    if (n >= OUO_SESSION_MAX) n = OUO_SESSION_MAX - 1;
    if (n > 0) memcpy(g_session[next].id, session_id, n);
    g_session[next].id[n] = 0;
    g_session[next].started_ms = started_ms;
    atomic_store(&g_session_index, next);
}

void ouo_crash_record_exception(const char *name, const char *reason, const uintptr_t *addresses, size_t count, bool main_thread) {
    if (atomic_flag_test_and_set(&g_handling)) return;
    uintptr_t frames[OUO_MAX_FRAMES];
    int n = 0;
    for (size_t i = 0; i < count && n < OUO_MAX_FRAMES; i++) {
        uintptr_t a = strip_pac(addresses[i]);
        if (a != 0) frames[n++] = a;
    }
    w_header("nsexception", main_thread);
    w("\"exception\":{\"name\":");
    w_str(name);
    w(",\"reason\":");
    w_str(reason);
    w("},");
    w_frames_and_images(frames, n);
    w_char('}');
    flush_report();
    atomic_store(&g_exception_recorded, true);
    // The runtime calls abort() next: let the SIGABRT through to the previous handlers without a
    // second report, but keep chaining.
    atomic_flag_clear(&g_handling);
}
