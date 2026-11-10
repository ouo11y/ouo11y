package bench
import android.app.Application
import okhttp3.OkHttpClient
object Sdk {
  const val NAME = "baseline"
  fun init(app: Application) {}
  fun decorate(b: OkHttpClient.Builder) = b
  fun captureHandled(e: Throwable) {}
}
