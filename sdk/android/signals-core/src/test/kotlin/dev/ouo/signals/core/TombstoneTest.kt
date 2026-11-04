package dev.ouo.signals.core

import java.io.ByteArrayOutputStream
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TombstoneTest {
  private fun fixture(name: String): ByteArray = javaClass.getResourceAsStream("/tombstones/$name")!!.use { it.readBytes() }

  /** A real tombstone: `kill -SEGV` of toybox `sleep` on the API 35 arm64 emulator (/data/tombstones/tombstone_00.pb). */
  @Test
  fun parsesARealApi35Tombstone() {
    val t = Tombstone.parse(fixture("api35-toybox-sigsegv-si-user.pb"))!!
    assertEquals("arm64", t.arch)
    assertEquals(4084 to 4084, t.pid to t.tid)
    assertEquals("sleep", t.threadName)
    // `kill` sends no fault address: has_fault_address is false, the address absent.
    assertEquals(NativeSignal(11, "SIGSEGV", 0, "SI_USER", null), t.signal)
    assertNull(t.abortMessage)
    // 2026-11-04 03:44:53.013775285+0200, local time with the device's offset.
    assertEquals(Tombstone.parseTimestamp("2026-11-04T01:44:53.013Z".replace("T", " ").replace("Z", "+0000")), t.timestampMs)
    assertEquals(1793756693013L, t.timestampMs)
    assertEquals(5, t.frames.size)
    val top = t.frames[0]
    assertEquals(0x7e99522148L, top.pc)
    assertEquals(0xbe148L, top.relPc)
    assertEquals("/apex/com.android.runtime/lib64/bionic/libc.so", top.file)
    assertEquals("1b9fecf834d610f77e641f026ca7269b", top.buildId)
    assertEquals("nanosleep" to 8L, top.function to top.functionOffset)
    assertEquals(listOf("nanosleep", "sleep_main", "toybox_main", "main", "__libc_init"), t.frames.map { it.function })
    // One image per file, at pc - rel_pc (the first mapping of the ELF), sized to its last segment.
    assertEquals(listOf("/apex/com.android.runtime/lib64/bionic/libc.so", "/system/bin/toybox"), t.images.map { it.codeFile })
    val toybox = t.images[1]
    assertEquals(0x5f9d5ac000L, toybox.imageAddr)
    assertEquals(0x5f9d637000L - 0x5f9d5ac000L, toybox.imageSize)
    assertEquals(t.frames[1].imageAddr, toybox.imageAddr)
    assertEquals(t.frames[2].imageAddr, toybox.imageAddr)
  }

  /**
   * The example app's NDK crashes on the API 35 emulator (`action/crash-ndk`, the conformance suite's
   * C2.4 launches), trimmed for the repo: other threads, memory dumps, logcat and open fds dropped,
   * only the mappings of the files the frames name (and the one after each) kept.
   */
  @Test
  fun parsesTheAppsSigsegvInAnApkEmbeddedLibrary() {
    val t = Tombstone.parse(fixture("api35-app-sigsegv-libouochaos.pb"))!!
    assertEquals(5145 to 5164, t.pid to t.tid)
    // React Native's JS thread: the module function runs there.
    assertEquals("mqt_v_js", t.threadName)
    // A real bad access at 0: has_fault_address is set and the address field is absent (proto3's default 0).
    assertEquals(NativeSignal(11, "SIGSEGV", 1, "SEGV_MAPERR", 0L), t.signal)
    assertEquals("null pointer dereference", t.cause)
    assertEquals(65, t.frames.size)
    val top = t.frames[0]
    assertEquals("ouo_chaos_segv" to 12L, top.function to top.functionOffset)
    assertTrue(top.file!!.endsWith("/base.apk!libouochaos.so"))
    assertEquals(0x7b4L, top.relPc)
    assertEquals("d98bdee3d57c72dc32437afb5aa4313c00c9bdc6", top.buildId)
    // The library is mapped from inside the APK: three pages under the APK's name, then another file.
    val lib = t.images.first { it.codeFile.endsWith("libouochaos.so") }
    assertEquals(0x748fd6d000L to 0x3000L, lib.imageAddr to lib.imageSize)
    // Java frames run by the interpreter are named by the dex method (in base.vdex / boot.oat).
    assertTrue(t.frames.any { it.function == "expo.modules.kotlin.functions.SyncFunctionComponent.callUserImplementation" })
    val r = JSONObject(t.toReport(RunState(5145, "s1"), exitTimestampMs = 1793757748000L).toJson())
    // 2026-11-04 04:02:27.182+0200.
    assertEquals(1793757747182L, r.getLong("timestamp_ms"))
    assertEquals("0x0", r.getJSONObject("signal").getString("address"))
    assertFalse(r.getJSONObject("thread").getBoolean("main"))
  }

  @Test
  fun parsesTheAppsAbortWithItsMessage() {
    val t = Tombstone.parse(fixture("api35-app-sigabrt-abort-message.pb"))!!
    // `abort()` raises SIGABRT with code SI_QUEUE (-1) on this build, not SI_TKILL.
    assertEquals(NativeSignal(6, "SIGABRT", -1, "SI_QUEUE", null), t.signal)
    assertEquals("ouo-mobile: native abort from the Chaos module", t.abortMessage)
    assertEquals(listOf("abort", "ouo_chaos_abort", "Java_dev_ouo_chaos_NativeCrash_crash"), t.frames.take(3).map { it.function })
    assertEquals("/apex/com.android.runtime/lib64/bionic/libc.so", t.frames[0].file)
    // Two frames in the library, one image.
    assertEquals(t.frames[1].imageAddr, t.frames[2].imageAddr)
    assertEquals(1, t.images.count { it.codeFile.endsWith("libouochaos.so") })
  }

  @Test
  fun reportHasTheShapeOfTheIosSignalReport() {
    val t = Tombstone.parse(fixture("api35-toybox-sigsegv-si-user.pb"))!!
    val r = t.toReport(RunState(4084, "s1", 900), exitTimestampMs = 1793756694500L)
    val o = JSONObject(r.toJson())
    assertEquals("signal", o.getString("mechanism"))
    assertEquals("android", o.getString("platform"))
    // The tombstone's crash time, not the exit's (debuggerd held the process 1.5 s here).
    assertEquals(1793756693013L, o.getLong("timestamp_ms"))
    assertEquals("s1", o.getString("session_id"))
    assertEquals(900L, o.getLong("session_started_ms"))
    assertEquals("arm64", o.getString("arch"))
    assertTrue(o.getJSONObject("thread").getBoolean("main"))
    val sig = o.getJSONObject("signal")
    assertEquals(listOf<Any>(11, "SIGSEGV", 0, "SI_USER"), listOf(sig.getInt("number"), sig.getString("name"), sig.getInt("code"), sig.getString("code_name")))
    assertFalse(sig.has("address"))
    val f = o.getJSONArray("frames").getJSONObject(1)
    assertEquals("0x5f9d5fd9fc", f.getString("instruction_addr"))
    assertEquals("0x5f9d5ac000", f.getString("image_addr"))
    assertEquals("sleep_main", f.getString("function"))
    assertEquals(92, f.getInt("function_offset"))
    val img = o.getJSONArray("images").getJSONObject(1)
    assertEquals("/system/bin/toybox", img.getString("code_file"))
    assertEquals("381ec694cdeb9e8dc14b0e50c1afb8d2", img.getString("code_id"))
    assertEquals("94c61e38-ebcd-8d9e-c14b-0e50c1afb8d2", img.getString("debug_id"))
    assertEquals("0x5f9d5ac000", img.getString("image_addr"))
    assertEquals("0x0", img.getString("image_vmaddr"))
    // An implausible tombstone time (a clock jump) falls back to the exit's.
    assertEquals(5_000_000L, t.toReport(RunState(4084), exitTimestampMs = 5_000_000L).timestampMs)
  }

  @Test
  fun syntheticTombstoneWithAbortMessageAndFaultAddress() {
    val t = Tombstone.parse(tombstone(abort = "Hermes fatal: boom", fault = 0L, codeName = "SI_TKILL"))!!
    assertEquals("Hermes fatal: boom", t.abortMessage)
    assertEquals(0L, t.signal!!.faultAddress)
    assertEquals("null pointer dereference", t.cause)
    // The crashing thread (tid 7) is not the main one (pid 5); the other thread's frames are not taken.
    assertEquals("mqt_js", t.threadName)
    assertEquals(listOf("crash_here"), t.frames.map { it.function })
    val f = t.frames[0]
    assertEquals("/data/app/~~x/dev.ouo-y/base.apk!libouochaos.so", f.file)
    // Mapped under the APK's name: the image is found by the part before `!`.
    assertEquals(0x7000L to 0x3000L, t.images[0].imageAddr to t.images[0].imageSize)
    // An anonymous frame (JIT code): no file, no image.
    val anon = Tombstone.parse(tombstone(file = "[anon:dalvik-jit-code-cache]"))!!.frames[0]
    assertNull(anon.file)
    assertNull(anon.imageAddr)
    val o = JSONObject(t.toReport(RunState(5, "s"), 0).toJson())
    assertFalse(o.getJSONObject("thread").getBoolean("main"))
    assertEquals("mqt_js", o.getJSONObject("thread").getString("name"))
    assertEquals("Hermes fatal: boom", o.getString("abort_message"))
    assertEquals("null pointer dereference", o.getString("cause"))
    assertEquals("0x0", o.getJSONObject("signal").getString("address"))
  }

  @Test
  fun notATombstone() {
    assertNull(Tombstone.parse(ByteArray(0)))
    // A text tombstone (what Android 11 kept on disk) is not a protobuf.
    assertNull(Tombstone.parse("*** *** *** *** ***\nBuild fingerprint: 'x'\npid: 1, tid: 1".toByteArray()))
    assertNull(Tombstone.parse(ByteArray(64) { 0xff.toByte() }))
  }

  /**
   * A tombstone cut short (past MAX_BYTES, a partial file) keeps the crash when the cut comes after
   * the crashing thread: debuggerd writes fields in number order, and the big ones (mappings 17,
   * logcat 18, fds 19) come last. Cut before or inside the thread, it is not a tombstone.
   */
  @Test
  fun truncatedTombstones() {
    for (name in listOf("api35-toybox-sigsegv-si-user.pb", "api35-app-sigsegv-libouochaos.pb", "api35-app-sigabrt-abort-message.pb")) {
      val real = fixture(name)
      val full = Tombstone.parse(real)!!
      val threadEnd = endOfField(real, 16)
      assertTrue(threadEnd in 1 until real.size)
      var kept = 0
      for (cut in 1 until real.size) {
        val t = Tombstone.parse(real.copyOf(cut))
        if (cut < threadEnd) {
          assertNull("$name cut at $cut", t)
        } else {
          assertEquals("$name cut at $cut", full.frames, t!!.frames)
          assertEquals(full.signal to full.abortMessage, t.signal to t.abortMessage)
          kept++
        }
      }
      assertTrue(kept > 0)
    }
  }

  /** The offset just past the last top-level field number [n] (the crashing thread's entry for 16 in these fixtures). */
  private fun endOfField(b: ByteArray, n: Int): Int {
    var pos = 0
    var end = -1
    fun varint(): Long {
      var r = 0L
      var s = 0
      while (true) {
        val c = b[pos++].toInt()
        r = r or ((c and 0x7f).toLong() shl s)
        if (c and 0x80 == 0) return r
        s += 7
      }
    }
    while (pos < b.size) {
      val t = varint().toInt()
      when (t and 7) {
        0 -> varint()
        1 -> pos += 8
        2 -> {
          val len = varint().toInt()
          pos += len
        }
        5 -> pos += 4
      }
      if (t ushr 3 == n) end = pos
    }
    return end
  }

  @Test
  fun timestamps() {
    assertEquals(0L, Tombstone.parseTimestamp("1970-01-01 00:00:00.000000000+0000"))
    assertEquals(1_500L, Tombstone.parseTimestamp("1970-01-01 01:00:01.5+0100"))
    assertEquals(3_600_000L, Tombstone.parseTimestamp("1969-12-31 23:30:00.000000000-0130"))
    assertEquals(951_782_400_000L, Tombstone.parseTimestamp("2000-02-29 00:00:00+0000"))
    assertNull(Tombstone.parseTimestamp("yesterday"))
  }

  @Test
  fun debugIds() {
    assertEquals("f8ec9f1b-d634-f710-7e64-1f026ca7269b", Tombstone.debugId("1b9fecf834d610f77e641f026ca7269b"))
    // A 20-byte GNU build id: its first 16 bytes; a short one is zero-padded.
    assertEquals("44332211-6655-8877-99aa-bbccddeeff00", Tombstone.debugId("112233445566778899aabbccddeeff0011223344"))
    assertEquals("00002211-0000-0000-0000-000000000000", Tombstone.debugId("1122"))
    assertNull(Tombstone.debugId("not hex"))
  }

  // ---- the decision: one exit, one record ----

  private val run = RunState(5, "s1", 900)

  private fun nativeExit(pid: Int = 5, importance: Int = 100) = Exit(pid, Termination.REASON_CRASH_NATIVE, importance, 11, 50_000)

  @Test
  fun nativeCrashReplacesTheTermination() {
    val stone = tombstone()
    val native = NativeCrash.decide(run, nativeExit(), stone, crashReported = false)!!
    assertEquals("signal" to "s1", native.mechanism to native.sessionId)
    // With the native report, the termination rule reports nothing for the same exit.
    assertNull(Termination.decide(run, nativeExit(), crashReported = true))
    // A crash in the background is a crash too (as a JVM crash is).
    assertEquals("signal", NativeCrash.decide(run, nativeExit(importance = 400), stone, false)!!.mechanism)
  }

  @Test
  fun noNativeCrash() {
    val stone = tombstone()
    // No tombstone (Android 11) or an unreadable one: the termination rule's `unknown` stays.
    assertNull(NativeCrash.decide(run, nativeExit(), null, false))
    assertNull(NativeCrash.decide(run, nativeExit(), ByteArray(3), false))
    assertEquals("unknown", Termination.decide(run, nativeExit(), crashReported = false)!!.terminationCause)
    // A JVM crash report wins; another process's exit or tombstone is not this run's.
    assertNull(NativeCrash.decide(run, nativeExit(), stone, crashReported = true))
    assertNull(NativeCrash.decide(run, nativeExit(pid = 6), stone, false))
    assertNull(NativeCrash.decide(run.copy(pid = 6), nativeExit(pid = 6), stone, false))
    assertNull(NativeCrash.decide(null, nativeExit(), stone, false))
    // Not a native crash exit.
    assertNull(NativeCrash.decide(run, Exit(5, Termination.REASON_CRASH, 100, 0, 50_000), stone, false))
  }

  // ---- a tiny protobuf writer for synthetic tombstones ----

  private class W {
    val out = ByteArrayOutputStream()

    fun varint(v: Long) {
      var x = v
      while (x and 0x7fL.inv() != 0L) {
        out.write(((x and 0x7f) or 0x80).toInt())
        x = x ushr 7
      }
      out.write(x.toInt())
    }

    fun int(n: Int, v: Long) = apply { varint((n shl 3).toLong()); varint(v) }

    fun bytes(n: Int, b: ByteArray) = apply { varint((n shl 3 or 2).toLong()); varint(b.size.toLong()); out.write(b) }

    fun str(n: Int, s: String) = bytes(n, s.toByteArray())

    fun msg(n: Int, w: W) = bytes(n, w.out.toByteArray())
  }

  private fun tombstone(abort: String? = null, fault: Long? = null, codeName: String = "SEGV_MAPERR", file: String = "/data/app/~~x/dev.ouo-y/base.apk!libouochaos.so"): ByteArray {
    val frame = W().int(1, 0x1234).int(2, 0x8234).str(4, "crash_here").int(5, 12).str(6, file).str(8, "abcdef0123456789")
    val crashed = W().int(1, 7).str(2, "mqt_js").msg(4, frame)
    val other = W().int(1, 5).str(2, "main").msg(4, W().int(1, 1).int(2, 2).str(4, "other_thread_fn"))
    val sig = W().int(1, 11).str(2, "SIGSEGV").int(3, 1).str(4, codeName)
    if (fault != null) sig.int(8, 1).int(9, fault)
    val t = W().int(1, 1).str(4, "2026-11-04 03:44:53.013775285+0200").int(5, 5).int(6, 7).msg(10, sig)
    if (abort != null) t.str(14, abort)
    t.msg(15, W().str(1, "null pointer dereference"))
    t.msg(16, W().int(1, 5).msg(2, other)).msg(16, W().int(1, 7).msg(2, crashed))
    // The APK's mappings: the library's segments at 0x7000..0xa000, then another file.
    t.msg(17, W().int(1, 0x7000).int(2, 0x9000).str(7, "/data/app/~~x/dev.ouo-y/base.apk"))
    t.msg(17, W().int(1, 0x9000).int(2, 0xa000).str(7, "/data/app/~~x/dev.ouo-y/base.apk"))
    t.msg(17, W().int(1, 0xa000).int(2, 0xb000).str(7, "[anon:.bss]"))
    t.msg(17, W().int(1, 0xc000).int(2, 0xd000).str(7, "/data/app/~~x/dev.ouo-y/base.apk"))
    // A field ouo does not read (log buffers) and an unknown fixed64 one are skipped.
    t.msg(18, W().str(1, "main"))
    t.out.write((99 shl 3) or 1)
    t.out.write(ByteArray(8))
    return t.out.toByteArray()
  }
}
