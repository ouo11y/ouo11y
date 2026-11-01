package dev.ouo.replay.core

/** Debug log sink; the Android target prints to logcat under the tag `ouo`. */
interface Logger {
  fun log(message: String)

  fun warn(message: String)

  companion object {
    val NONE: Logger = object : Logger {
      override fun log(message: String) {}

      override fun warn(message: String) {}
    }
  }
}
