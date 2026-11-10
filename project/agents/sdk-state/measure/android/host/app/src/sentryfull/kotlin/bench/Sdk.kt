package bench
import android.app.Application
import io.sentry.Sentry
import io.sentry.android.core.SentryAndroid
import io.sentry.okhttp.SentryOkHttpInterceptor
import okhttp3.OkHttpClient
/** sentry-android 8.x with tracing on and the OkHttp integration, against the capture server. */
object Sdk {
  const val NAME = "sentryfull"
  fun init(app: Application) {
    SentryAndroid.init(app) { o ->
      o.dsn = "http://pub@10.0.2.2:8712/1"
      o.tracesSampleRate = 1.0
      o.sessionReplay.sessionSampleRate = 1.0
      o.sessionReplay.onErrorSampleRate = 1.0
    }
  }
  fun decorate(b: OkHttpClient.Builder) = b.addInterceptor(SentryOkHttpInterceptor())
  fun captureHandled(e: Throwable) { Sentry.captureException(e) }
}
