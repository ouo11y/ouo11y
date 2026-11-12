// What the code copied from sentry-java (src/main/upstream, sentry-core-sync.sh) needs from the
// Sentry SDK, re-implemented with only the members it calls. The copy's `io.sentry.` package
// prefix is rewritten to `dev.ouo.sentrycore.`, so these classes stand where Sentry's are.
//
// | Upstream (sentry 8.64.0)                         | Used by                  | Here                                  |
// |--------------------------------------------------|--------------------------|---------------------------------------|
// | `io.sentry.SentryOptions` (`logger`, `sessionReplay`) | SimpleVideoEncoder  | [SentryOptions]: a logger and a debug flag |
// | `io.sentry.SentryReplayOptions.isDebug`          | SimpleVideoEncoder       | [SentryReplayOptions]                  |
// | `io.sentry.ILogger.log(level, message, ...)`     | SimpleVideoEncoder       | [ILogger] to an ouo sink               |
// | `io.sentry.SentryLevel`                          | SimpleVideoEncoder       | [SentryLevel]                          |
package dev.ouo.sentrycore

enum class SentryLevel { DEBUG, INFO, WARNING, ERROR, FATAL }

/** Sentry's `ILogger`, the two forms the copy calls. Messages never hold screen content (ERR-8): the copy logs codec states and sizes only. */
interface ILogger {
  fun log(level: SentryLevel, message: String, vararg args: Any?)

  fun log(level: SentryLevel, message: String, throwable: Throwable?)
}

class SentryReplayOptions(val isDebug: Boolean = false)

/** Sentry's options, reduced to what the copy reads. */
class SentryOptions(val logger: ILogger, val sessionReplay: SentryReplayOptions = SentryReplayOptions()) {
  companion object {
    /** Logs to [sink] (null: nowhere); debug lines only when [debug]. Exceptions by class name only (ERR-8). */
    fun of(debug: Boolean, sink: ((String) -> Unit)?): SentryOptions =
      SentryOptions(
        object : ILogger {
          override fun log(level: SentryLevel, message: String, vararg args: Any?) {
            if (sink == null || (level == SentryLevel.DEBUG && !debug)) return
            val text = try {
              if (args.isEmpty()) message else String.format(java.util.Locale.ROOT, message, *args)
            } catch (e: Throwable) {
              message
            }
            sink("[sentry-core] ${level.name.lowercase()}: $text")
          }

          override fun log(level: SentryLevel, message: String, throwable: Throwable?) =
            log(level, if (throwable == null) message else "$message (${throwable.javaClass.simpleName})")
        },
        SentryReplayOptions(debug),
      )
  }
}
