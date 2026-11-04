// Demo-only (Android): deliberate NDK crashes for the conformance suite's C2.4 (a crash in C code,
// as one in Hermes, Fabric or a third-party .so would be). Not part of the SDK.
#include <android/set_abort_message.h>
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

// Read at run time, so the compiler cannot prove the store below writes to address 0 and replace
// it with a trap instruction (which would be a SIGTRAP / SIGILL, not the SIGSEGV a bad pointer gives).
static volatile uintptr_t ouo_chaos_null = 0;

// Exported and not inlined: the tombstone names these frames from the .so's dynamic symbols.
__attribute__((noinline, visibility("default"))) void ouo_chaos_segv(void) {
  *(volatile int *)ouo_chaos_null = 42;
}

__attribute__((noinline, visibility("default"))) void ouo_chaos_abort(const char *message) {
  android_set_abort_message(message);
  abort();
}

// dev.ouo.chaos.NativeCrash.crash(kind): 0 = SIGSEGV at address 0, 1 = abort() with a message.
JNIEXPORT void JNICALL Java_dev_ouo_chaos_NativeCrash_crash(JNIEnv *env, jclass cls, jint kind) {
  (void)env;
  (void)cls;
  if (kind == 1) ouo_chaos_abort("ouo-mobile: native abort from the Chaos module");
  ouo_chaos_segv();
}
