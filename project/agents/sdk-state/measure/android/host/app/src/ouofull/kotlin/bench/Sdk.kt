package bench
import android.app.Application
import dev.ouo.replay.OuoReplay
import dev.ouo.replay.OuoReplayConfig
import dev.ouo.replay.core.ReplayMode
import dev.ouo.signals.Signals
import okhttp3.OkHttpClient
import java.util.UUID
/** ouo native signals + session replay, as the RN SDK starts them, against the capture server. */
object Sdk {
  const val NAME = "ouofull"
  val sessionId = UUID.randomUUID().toString()
  fun init(app: Application) {
    Signals.init(app)
    Signals.install(sessionId, System.currentTimeMillis()) { }
    OuoReplay.start(app, OuoReplayConfig(
      endpoint = "http://10.0.2.2:8712", projectId = "bench", projectToken = "bench",
      sessionId = { sessionId }, mode = ReplayMode.SESSION,
    ))
  }
  fun decorate(b: OkHttpClient.Builder) = b
  fun captureHandled(e: Throwable) {}
}
