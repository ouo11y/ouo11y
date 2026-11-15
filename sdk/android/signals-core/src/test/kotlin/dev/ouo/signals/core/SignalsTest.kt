package dev.ouo.signals.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SignalsTest {
  @Test
  fun reportHasTheFieldsTheReactNativeSdkReads() {
    val (name, reason) = Report.describe(RuntimeException("outer", IllegalStateException("inner")))
    val r = Report("jvm", 1000, "s1", 900, name, reason, true, Report.frames(arrayOf(StackTraceElement("com.example.Cart", "checkout", "Cart.kt", 42))))
    val o = JSONObject(r.toJson())
    assertEquals("jvm", o.getString("mechanism"))
    assertEquals(1000L, o.getLong("timestamp_ms"))
    assertEquals("s1", o.getString("session_id"))
    assertEquals(900L, o.getLong("session_started_ms"))
    assertEquals("java.lang.RuntimeException", o.getJSONObject("exception").getString("name"))
    assertEquals("outer\nCaused by: java.lang.IllegalStateException: inner", o.getJSONObject("exception").getString("reason"))
    assertTrue(o.getJSONObject("thread").getBoolean("main"))
    val f = o.getJSONArray("frames").getJSONObject(0)
    assertEquals(listOf("com.example.Cart", "checkout", "Cart.kt", 42), listOf(f.getString("module"), f.getString("function"), f.getString("filename"), f.getInt("lineno")))
    assertEquals(0, o.getJSONArray("images").length())
    val hang = JSONObject(Report("hang", 1, "s1", hangDurationMs = 3100, hangFullyBlocking = true).toJson())
    assertEquals(3100L, hang.getJSONObject("hang").getLong("duration_ms"))
    assertEquals(Report.MAX_FRAMES, Report.frames(Array(500) { StackTraceElement("C", "m", null, -1) }).size)
  }

  @Test
  fun runStateRoundTrips() {
    val s = RunState(42, "s1", 900, memoryWarningMs = 1000, hangStartedMs = 1100, hangFrames = listOf(JvmFrame("A", "b", null, null)))
    assertEquals(s, RunState.parse(s.toJson()))
    assertNull(RunState.parse("{not json"))
    assertNull(RunState.parse(null))
  }

  private val run = RunState(42, "s1", 900)

  private fun exit(reason: Int, importance: Int = 100, signal: Int = 0, at: Long = 50_000, pid: Int = 42) = Exit(pid, reason, importance, signal, at)

  @Test
  fun terminationCauses() {
    val lmk = Termination.decide(run, exit(Termination.REASON_LOW_MEMORY), false)!!
    assertEquals("memory" to 50_000L, lmk.terminationCause to lmk.timestampMs)
    assertEquals("s1", lmk.sessionId)
    assertEquals(900L, lmk.sessionStartedMs)
    assertEquals("watchdog", Termination.decide(run, exit(Termination.REASON_ANR), false)!!.terminationCause)
    assertEquals("cpu", Termination.decide(run, exit(Termination.REASON_EXCESSIVE_RESOURCE_USAGE), false)!!.terminationCause)
    assertEquals("unknown", Termination.decide(run, exit(Termination.REASON_CRASH_NATIVE), false)!!.terminationCause)
    // A SIGKILL: memory after a warning in the last minute, watchdog during a hang, else unknown.
    assertEquals("unknown", Termination.decide(run, exit(Termination.REASON_SIGNALED, signal = 9), false)!!.terminationCause)
    assertEquals("memory", Termination.decide(run.copy(memoryWarningMs = 49_000), exit(Termination.REASON_SIGNALED, signal = 9), false)!!.terminationCause)
    assertEquals("unknown", Termination.decide(run.copy(memoryWarningMs = 1_000), exit(Termination.REASON_SIGNALED, signal = 9, at = 200_000), false)!!.terminationCause)
    val hung = Termination.decide(run.copy(hangStartedMs = 48_000, hangFrames = listOf(JvmFrame("A", "b", null, 1))), exit(Termination.REASON_SIGNALED, signal = 9), false)!!
    assertEquals("watchdog" to 1, hung.terminationCause to hung.frames.size)
  }

  @Test
  fun notTerminations() {
    for (reason in listOf(Termination.REASON_USER_REQUESTED, Termination.REASON_USER_STOPPED, Termination.REASON_EXIT_SELF, Termination.REASON_PACKAGE_UPDATED, Termination.REASON_PERMISSION_CHANGE, Termination.REASON_CRASH, Termination.REASON_OTHER)) {
      assertNull("reason $reason", Termination.decide(run, exit(reason), false))
    }
    assertNull("background", Termination.decide(run, exit(Termination.REASON_LOW_MEMORY, importance = 400), false))
    assertNull("a foreground service of a backgrounded app", Termination.decide(run, exit(Termination.REASON_LOW_MEMORY, importance = 125), false))
    assertNull("perceptible", Termination.decide(run, exit(Termination.REASON_LOW_MEMORY, importance = 230), false))
    assertEquals("visible", "memory", Termination.decide(run, exit(Termination.REASON_LOW_MEMORY, importance = 200), false)?.terminationCause)
    assertNull("another process", Termination.decide(run, exit(Termination.REASON_LOW_MEMORY, pid = 7), false))
    assertNull("the crash wins", Termination.decide(run, exit(Termination.REASON_LOW_MEMORY), true))
    assertNull("another signal", Termination.decide(run, exit(Termination.REASON_SIGNALED, signal = 15), false))
    assertNull("no exit record (before Android 11)", Termination.decide(run, null, false))
    assertNull("first run", Termination.decide(null, exit(Termination.REASON_LOW_MEMORY), false))
  }

  @Test
  fun oneHangPerBlockFromItsLastAnswer() {
    val d = HangDetector()
    var answer = 0L
    // The main thread answers every tick, then stops at 1000 for 3 s.
    for (t in 200L..1000L step 200) {
      answer = t
      assertNull(d.tick(t, answer))
    }
    for (t in 1200L..2800L step 200) assertNull(d.tick(t, answer))
    assertEquals(HangDetector.Event.Started(1000), d.tick(3000, answer))
    assertNull(d.tick(3200, answer))
    assertNull(d.tick(4000, answer))
    answer = 4050
    assertEquals(HangDetector.Event.Ended(1000, 4050), d.tick(4200, answer))
    assertEquals(3050L, (HangDetector.Event.Ended(1000, 4050)).durationMs)
    // Blocked again right away: nothing within the 2 s quiet period, then the new block from its start.
    assertNull(d.tick(6000, answer))
    assertEquals(HangDetector.Event.Started(4050), d.tick(6200, answer))
  }

  @Test
  fun aHangTheUserLeavesTheAppDuringIsReported() {
    // The main thread answers at 1000, then blocks; the watchdog ticks every 200 ms.
    fun hung() = HangDetector().also { h ->
      for (t in 1000L..2800L step 200) assertNull(h.tick(t, 1000))
      assertEquals(HangDetector.Event.Started(1000), h.tick(3000, 1000))
    }
    val d = hung()
    // Home pressed: onStop ran on the main thread at 4100, before the watchdog's message.
    assertEquals(HangDetector.Event.Ended(1000, 4100), d.interrupt(4100, 1000))
    assertTrue(!d.inHang)
    // The watchdog's message ran first: the hang ends at that answer.
    val e = hung()
    assertEquals(HangDetector.Event.Ended(1000, 3900), e.interrupt(4100, 3900))
    // No hang in progress: nothing, and measuring restarts (no gap is seen as a frozen watchdog).
    assertNull(e.interrupt(9000, 9000))
    assertNull(e.tick(60_000, 60_000))
    assertNull(e.tick(60_200, 60_200))
  }

  @Test
  fun shortBlocksAndFrozenWatchdogsAreNotHangs() {
    val d = HangDetector()
    assertNull(d.tick(1000, 900))
    assertNull("a 1.8 s block", d.tick(2700, 900))
    // The watchdog itself stopped for 10 s (process frozen): no hang from that gap.
    assertNull(d.tick(12_700, 900))
    assertTrue(!d.inHang)
  }

  @Test
  fun framesAndAppStart() {
    val c = FrameCounter()
    assertNull(c.snapshot())
    c.frame(10.0, 16.6)
    c.frame(40.0, 16.6)
    c.frame(800.0, 16.6)
    val s = c.snapshot()!!
    assertEquals(listOf(3.0, 1.0, 1.0), listOf(s["total"], s["slow"], s["frozen"]))
    assertEquals(23.4 + 783.4, s["delayMs"]!!, 1e-6)
    assertEquals("cold" to 1000L, AppStart.of(1000, 3000, true, null))
    assertEquals("warm" to 60_000L, AppStart.of(1000, 60_000, true, null))
    assertEquals("warm" to 3000L, AppStart.of(1000, 3000, true, false))
    assertEquals("cold" to 1000L, AppStart.of(1000, 60_000, true, true))
    assertEquals("warm" to 3000L, AppStart.of(1000, 3000, false, true))
  }

  @Test
  fun mappingIdFromTheDebugMetaAsset() {
    val id = "0F9C2E4A-1B2C-4D3E-8F90-123456789ABC"
    assertEquals(id.lowercase(), Report.mappingId("# ouo\nmapping_id=$id\n"))
    assertNull(Report.mappingId("mapping_id=not-a-uuid"))
    assertNull(Report.mappingId(null))
    val json = JSONObject(Report(mechanism = "jvm", timestampMs = 1, sessionId = "s", mappingId = id.lowercase()).toJson())
    assertEquals(id.lowercase(), json.getString("mapping_id"))
    assertTrue(!JSONObject(Report(mechanism = "jvm", timestampMs = 1, sessionId = "s").toJson()).has("mapping_id"))
  }
}
