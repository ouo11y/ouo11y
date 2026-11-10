package bench
import android.app.Application
import dev.ouo.signals.Signals
import okhttp3.OkHttpClient
import java.util.UUID
/** ouo native signals only: crash handler, hang watchdog, exit info, frame counters (sdk/android `signals`). */
object Sdk {
  const val NAME = "ouosignals"
  val sessionId = UUID.randomUUID().toString()
  fun init(app: Application) {
    Signals.init(app)
    Signals.install(sessionId, System.currentTimeMillis()) { }
  }
  fun decorate(b: OkHttpClient.Builder) = b // no native HTTP instrumentation (the RN SDK does it in JS)
  fun captureHandled(e: Throwable) {} // no native handled-error API (the RN SDK does it in JS)
}
