package bench

import android.app.Activity
import android.app.Application
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.Executors

/** The app's own API (not telemetry): a separate port of the capture server. */
const val API = "http://10.0.2.2:8711"

class App : Application() {
  override fun onCreate() {
    super.onCreate()
    val t0 = SystemClock.elapsedRealtimeNanos()
    Sdk.init(this)
    val dt = SystemClock.elapsedRealtimeNanos() - t0
    Log.i("ouobench", "init_ns=$dt variant=${Sdk.NAME}")
    http = Sdk.decorate(OkHttpClient.Builder()).build()
  }

  companion object {
    lateinit var http: OkHttpClient
    val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /** Two GETs and one POST, like a screen loading its data and reporting an action. */
    fun fetch(status: TextView) = io.execute {
      val out = StringBuilder()
      runCatching {
        for (i in 1..2) http.newCall(Request.Builder().url("$API/api/items?page=$i").build()).execute().use { out.append(it.code).append(' ') }
        val body = """{"action":"view","at":${System.currentTimeMillis()}}""".toRequestBody("application/json".toMediaType())
        http.newCall(Request.Builder().url("$API/api/events").post(body).build()).execute().use { out.append(it.code) }
      }.onFailure { out.append(it.javaClass.simpleName) }
      main.post { status.text = "fetched: $out at ${SystemClock.uptimeMillis()}" }
    }

    fun handledError(status: TextView) {
      try {
        throw IllegalStateException("bench handled error")
      } catch (e: IllegalStateException) {
        Sdk.captureHandled(e)
        status.text = "handled ${e.message}"
      }
    }
  }
}

/** One column of full-width 200 px buttons from y = 300 px, so the journey script taps fixed points. */
fun Activity.screen(title: String, vararg buttons: Pair<String, (TextView) -> Unit>): TextView {
  val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 300, 40, 40); setBackgroundColor(Color.WHITE) }
  val status = TextView(this).apply { textSize = 16f }
  for ((label, action) in buttons) {
    root.addView(Button(this).apply { text = label; setOnClickListener { action(status) } }, LinearLayout.LayoutParams(-1, 200).apply { bottomMargin = 40 })
  }
  root.addView(TextView(this).apply { text = title; textSize = 24f; gravity = Gravity.CENTER })
  root.addView(status)
  setContentView(root)
  return status
}

class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    screen(
      "Home",
      "Fetch" to { s -> App.fetch(s) },
      "Open list" to { _ -> startActivity(android.content.Intent(this, ListActivity::class.java)) },
      "Open detail" to { _ -> startActivity(android.content.Intent(this, DetailActivity::class.java)) },
    )
  }
}

class DetailActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    screen("Detail", "Fetch" to { s -> App.fetch(s) }, "Handled error" to { s -> App.handledError(s) })
  }
}

class ListActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val list = ListView(this).apply { setBackgroundColor(Color.WHITE); setPadding(0, 300, 0, 0); clipToPadding = false }
    list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, (1..300).map { "Row $it: some product name and a price ${it * 3}.99" })
    setContentView(list)
  }
}
