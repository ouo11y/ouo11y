package dev.ouo.chaos

/** Demo-only: the deliberate NDK crashes of `libouochaos.so` (src/main/cpp/ouo_chaos_crash.c). */
object NativeCrash {
  const val SEGV = 0
  const val ABORT = 1

  init {
    System.loadLibrary("ouochaos")
  }

  /** Crashes the process in C code on the calling thread: [SEGV] or [ABORT]. Never returns. */
  @JvmStatic external fun crash(kind: Int)
}
