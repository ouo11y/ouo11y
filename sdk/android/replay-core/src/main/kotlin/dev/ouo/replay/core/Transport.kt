package dev.ouo.replay.core

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPOutputStream

/** What the receiver answered; [status] 0 when the request did not reach it. */
data class HttpAnswer(val status: Int, val retryAfter: String? = null) {
  /** `Retry-After` in seconds when it is a number (the receiver sends whole seconds with 429 and 503). */
  val retryAfterSeconds: Double? get() = retryAfter?.trim()?.toDoubleOrNull()
}

data class HttpRequest(val url: String, val headers: Map<String, String>, val body: ByteArray)

/** The HTTP send, abstracted so tests capture requests without a server. Blocking; callers own the thread. */
fun interface Transport {
  fun send(request: HttpRequest): HttpAnswer
}

/** `java.net` POST with a 15 s timeout; any I/O failure is status 0. */
object UrlConnectionTransport : Transport {
  override fun send(request: HttpRequest): HttpAnswer {
    var conn: HttpURLConnection? = null
    return try {
      conn = URL(request.url).openConnection() as HttpURLConnection
      conn.requestMethod = "POST"
      conn.connectTimeout = 15_000
      conn.readTimeout = 15_000
      conn.doOutput = true
      conn.useCaches = false
      for ((k, v) in request.headers) conn.setRequestProperty(k, v)
      conn.setFixedLengthStreamingMode(request.body.size)
      conn.outputStream.use { it.write(request.body) }
      val status = conn.responseCode
      // Drain the answer so the connection can be reused.
      runCatching { (if (status >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() } }
      HttpAnswer(status, conn.getHeaderField("Retry-After"))
    } catch (e: Exception) {
      HttpAnswer(0)
    } finally {
      conn?.disconnect()
    }
  }
}

object Gzip {
  fun compress(data: ByteArray): ByteArray {
    val out = ByteArrayOutputStream(data.size / 4 + 64)
    GZIPOutputStream(out).use { it.write(data) }
    return out.toByteArray()
  }
}

/** `Basic base64("<projectId>:<projectToken>")`, the credential the collector checks (ADR-0007). */
fun basicAuthorization(projectId: String, projectToken: String): String = "Basic " + base64("$projectId:$projectToken".toByteArray(Charsets.UTF_8))
