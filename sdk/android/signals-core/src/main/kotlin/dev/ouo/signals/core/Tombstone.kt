package dev.ouo.signals.core

import org.json.JSONObject

/** One frame of a native (C/C++) stack: the absolute [pc], and what the tombstone resolved of it. */
data class NativeFrame(
  val pc: Long,
  /** The address inside the ELF file (its vaddr space): what `llvm-symbolizer` / `addr2line` read with the `.so`. */
  val relPc: Long,
  /** The mapped file (`/data/app/.../base.apk!libfoo.so` for a library loaded from the APK), null for anonymous memory. */
  val file: String?,
  /** The ELF's GNU build id (hex), null when the file has none or could not be read. */
  val buildId: String?,
  /** The symbol the tombstone found in the ELF's symbol tables (exported or `.symtab`), null when none. */
  val function: String?,
  val functionOffset: Long?,
) {
  /** Where the ELF is loaded: `pc - relPc`, the same for every frame of one file. */
  val imageAddr: Long? get() = if (file != null) pc - relPc else null

  /** Sentry's native frame fields plus `function` / `function_offset` where the tombstone named the symbol. */
  fun toJson(): JSONObject {
    val o = JSONObject().put("instruction_addr", hex(pc))
    imageAddr?.let { o.put("image_addr", hex(it)) }
    if (!function.isNullOrEmpty()) {
      o.put("function", function)
      if (functionOffset != null) o.put("function_offset", functionOffset)
    }
    return o
  }
}

/**
 * A binary image a frame points into, with Sentry's `debug_meta` names: [codeFile], `code_id` (the
 * GNU build id) and `debug_id` (the build id's first 16 bytes as a little-endian GUID, Sentry's ELF
 * debug id), the load address and the mapped size.
 */
data class NativeImage(val codeFile: String, val buildId: String?, val imageAddr: Long, val imageSize: Long) {
  fun toJson(): JSONObject {
    val o = JSONObject()
      .put("code_file", codeFile)
      .put("image_addr", hex(imageAddr))
      .put("image_size", imageSize)
      .put("image_vmaddr", "0x0")
    if (!buildId.isNullOrEmpty()) {
      o.put("code_id", buildId)
      Tombstone.debugId(buildId)?.let { o.put("debug_id", it) }
    }
    return o
  }
}

/** The signal of a native crash: number and name, `si_code` and its name, the fault address when the kernel gave one. */
data class NativeSignal(val number: Int, val name: String, val code: Int, val codeName: String, val faultAddress: Long?) {
  fun toJson(): JSONObject {
    val o = JSONObject().put("number", number).put("name", name).put("code", code)
    if (codeName.isNotEmpty()) o.put("code_name", codeName)
    if (faultAddress != null) o.put("address", hex(faultAddress))
    return o
  }
}

internal fun hex(v: Long): String = "0x" + java.lang.Long.toHexString(v)

/**
 * What ouo reads of an Android tombstone: the protobuf debuggerd writes since Android 12, which
 * `ApplicationExitInfo.getTraceInputStream()` returns for a `REASON_CRASH_NATIVE` exit
 * (system/core/debuggerd/proto/tombstone.proto; quirks in project/kb/android-ndk-tombstones.md).
 */
data class Tombstone(
  val arch: String?,
  val pid: Int,
  val tid: Int,
  /** The crash time (epoch ms) from the tombstone's local-time `timestamp`, null when unreadable. */
  val timestampMs: Long?,
  val signal: NativeSignal?,
  val abortMessage: String?,
  /** debuggerd's own diagnosis (`null pointer dereference`, a use-after-free from MTE / GWP-ASan), first one. */
  val cause: String?,
  val threadName: String?,
  val frames: List<NativeFrame>,
  val images: List<NativeImage>,
) {
  /**
   * The crash report of the run that died with this tombstone: mechanism `signal`, as on iOS, so the
   * JavaScript, rum-api and the plugin treat both alike. Stamped at the tombstone's crash time
   * (debuggerd's dump holds the process for up to a second or two before it dies, which is when
   * [exitTimestampMs] is), unless that time is missing or implausible.
   */
  fun toReport(previous: RunState?, exitTimestampMs: Long): Report {
    val at = timestampMs?.takeIf { it in (exitTimestampMs - PLAUSIBLE_MS)..(exitTimestampMs + CLOCK_SLACK_MS) } ?: exitTimestampMs
    return Report(
      mechanism = "signal",
      timestampMs = at,
      sessionId = previous?.sessionId ?: "",
      sessionStartedMs = previous?.sessionStartedMs?.takeIf { it > 0 },
      mainThread = tid == pid,
      arch = arch,
      pid = pid,
      threadName = threadName,
      signal = signal,
      abortMessage = abortMessage?.takeIf { it.isNotEmpty() },
      cause = cause?.takeIf { it.isNotEmpty() },
      nativeFrames = frames,
      images = images,
    )
  }

  companion object {
    /** A tombstone of a few MB is a huge memory dump; ouo never reads more. */
    const val MAX_BYTES = 8 * 1024 * 1024
    private const val PLAUSIBLE_MS = 60_000L
    private const val CLOCK_SLACK_MS = 5_000L

    private val ARCH = mapOf(0L to "arm", 1L to "arm64", 2L to "x86", 3L to "x86_64", 4L to "riscv64")

    /** Parses the tombstone protobuf; null when it is not one (empty, truncated, a text tombstone). */
    fun parse(bytes: ByteArray): Tombstone? = runCatching { parseOrThrow(bytes) }.getOrNull()

    private class RawThread(val id: Int, val name: String, val frames: List<NativeFrame>)

    private class Mapping(val begin: Long, val end: Long, val name: String)

    private fun parseOrThrow(bytes: ByteArray): Tombstone? {
      var arch: Long = -1
      var pid = 0
      var tid = 0
      var timestamp = ""
      var signal: NativeSignal? = null
      var abort = ""
      var cause: String? = null
      val threads = HashMap<Int, RawThread>()
      val mappings = ArrayList<Mapping>()
      val r = ProtoReader(bytes)
      // Lenient at the top level: debuggerd writes the fields in number order, so everything ouo
      // reads (up to 17) precedes the log buffers (18) and fds (19) that make a tombstone big. A
      // tombstone cut short (past MAX_BYTES, a partial file) keeps what was read before the cut,
      // and is a tombstone when the checks below hold.
      try {
        r.fields { n, w ->
          when {
            n == 1 && w == ProtoReader.WIRE_VARINT -> arch = r.varint()
            n == 4 && w == ProtoReader.WIRE_LEN -> timestamp = r.string()
            n == 5 && w == ProtoReader.WIRE_VARINT -> pid = r.varint().toInt()
            n == 6 && w == ProtoReader.WIRE_VARINT -> tid = r.varint().toInt()
            n == 10 && w == ProtoReader.WIRE_LEN -> signal = signal(r.message())
            n == 14 && w == ProtoReader.WIRE_LEN -> abort = r.string()
            n == 15 && w == ProtoReader.WIRE_LEN -> { val c = cause(r.message()); if (cause == null) cause = c }
            // map<uint32, Thread> threads: entries { 1: key, 2: Thread }.
            n == 16 && w == ProtoReader.WIRE_LEN -> threadEntry(r.message())?.let { threads[it.id] = it }
            n == 17 && w == ProtoReader.WIRE_LEN -> mapping(r.message())?.let(mappings::add)
            else -> return@fields false
          }
          true
        }
      } catch (e: IllegalArgumentException) {
        // Cut short: what precedes the cut counts (the checks below decide whether it is enough).
      }
      // A message without the fields every tombstone has (the crashing thread included) is not one:
      // a text tombstone parses as garbage or fails, a cut before the thread has no stack.
      if (pid <= 0 || tid <= 0 || signal == null) return null
      val crashed = threads[tid] ?: return null
      val frames = crashed.frames.take(Report.MAX_FRAMES)
      return Tombstone(
        arch = ARCH[arch],
        pid = pid,
        tid = tid,
        timestampMs = parseTimestamp(timestamp),
        signal = signal,
        abortMessage = abort.ifEmpty { null },
        cause = cause,
        threadName = crashed.name.ifEmpty { null },
        frames = frames,
        images = images(frames, mappings),
      )
    }

    private fun signal(r: ProtoReader): NativeSignal {
      var number = 0
      var name = ""
      var code = 0
      var codeName = ""
      var hasFault = false
      var fault = 0L
      r.fields { n, w ->
        when {
          n == 1 && w == ProtoReader.WIRE_VARINT -> number = r.varint().toInt()
          n == 2 && w == ProtoReader.WIRE_LEN -> name = r.string()
          n == 3 && w == ProtoReader.WIRE_VARINT -> code = r.varint().toInt()
          n == 4 && w == ProtoReader.WIRE_LEN -> codeName = r.string()
          n == 8 && w == ProtoReader.WIRE_VARINT -> hasFault = r.varint() != 0L
          n == 9 && w == ProtoReader.WIRE_VARINT -> fault = r.varint()
          else -> return@fields false
        }
        true
      }
      return NativeSignal(number, name.ifEmpty { "signal $number" }, code, codeName, if (hasFault) fault else null)
    }

    /** `Cause { string human_readable = 1; ... }`. */
    private fun cause(r: ProtoReader): String? {
      var text: String? = null
      r.fields { n, w ->
        if (n == 1 && w == ProtoReader.WIRE_LEN) { text = r.string(); true } else false
      }
      return text
    }

    private fun threadEntry(r: ProtoReader): RawThread? {
      var thread: RawThread? = null
      r.fields { n, w ->
        if (n == 2 && w == ProtoReader.WIRE_LEN) { thread = thread(r.message()); true } else false
      }
      return thread
    }

    /** `Thread { int32 id = 1; string name = 2; repeated BacktraceFrame current_backtrace = 4; ... }`. */
    private fun thread(r: ProtoReader): RawThread {
      var id = 0
      var name = ""
      val frames = ArrayList<NativeFrame>()
      r.fields { n, w ->
        when {
          n == 1 && w == ProtoReader.WIRE_VARINT -> id = r.varint().toInt()
          n == 2 && w == ProtoReader.WIRE_LEN -> name = r.string()
          n == 4 && w == ProtoReader.WIRE_LEN -> frames.add(frame(r.message()))
          else -> return@fields false
        }
        true
      }
      return RawThread(id, name, frames)
    }

    /** `BacktraceFrame { rel_pc = 1; pc = 2; sp = 3; function_name = 4; function_offset = 5; file_name = 6; file_map_offset = 7; build_id = 8 }`. */
    private fun frame(r: ProtoReader): NativeFrame {
      var relPc = 0L
      var pc = 0L
      var function = ""
      var offset = 0L
      var file = ""
      var buildId = ""
      r.fields { n, w ->
        when {
          n == 1 && w == ProtoReader.WIRE_VARINT -> relPc = r.varint()
          n == 2 && w == ProtoReader.WIRE_VARINT -> pc = r.varint()
          n == 4 && w == ProtoReader.WIRE_LEN -> function = r.string()
          n == 5 && w == ProtoReader.WIRE_VARINT -> offset = r.varint()
          n == 6 && w == ProtoReader.WIRE_LEN -> file = r.string()
          n == 8 && w == ProtoReader.WIRE_LEN -> buildId = r.string()
          else -> return@fields false
        }
        true
      }
      // Anonymous memory (JIT code, a corrupt pc): no file, the pc is all there is.
      val named = file.isNotEmpty() && !file.startsWith("[") && !file.startsWith("<")
      return NativeFrame(
        pc = pc,
        relPc = if (named) relPc else pc,
        file = if (named) file else null,
        buildId = buildId.ifEmpty { null },
        function = function.ifEmpty { null },
        functionOffset = if (function.isNotEmpty()) offset else null,
      )
    }

    /** `MemoryMapping { begin_address = 1; end_address = 2; ...; mapping_name = 7; ... }`. */
    private fun mapping(r: ProtoReader): Mapping? {
      var begin = 0L
      var end = 0L
      var name = ""
      r.fields { n, w ->
        when {
          n == 1 && w == ProtoReader.WIRE_VARINT -> begin = r.varint()
          n == 2 && w == ProtoReader.WIRE_VARINT -> end = r.varint()
          n == 7 && w == ProtoReader.WIRE_LEN -> name = r.string()
          else -> return@fields false
        }
        true
      }
      return if (name.isEmpty()) null else Mapping(begin, end, name)
    }

    /**
     * The images the frames point into, in frame order. The size runs from the load address to the
     * end of the file's mappings from there on (the ELF's segments, up to the first mapping of
     * another name). A library loaded from inside the APK is mapped under the APK's name while its
     * frames name `base.apk!libfoo.so`: the mappings are matched by the part before the `!`.
     */
    private fun images(frames: List<NativeFrame>, mappings: List<Mapping>): List<NativeImage> {
      val sorted = mappings.sortedBy { it.begin }
      val seen = LinkedHashMap<Long, NativeImage>()
      for (f in frames) {
        val file = f.file ?: continue
        val base = f.imageAddr ?: continue
        if (seen.containsKey(base)) continue
        val mapped = file.substringBefore('!')
        var end = 0L
        for (m in sorted) {
          if (m.end <= base) continue
          if (m.name != mapped) {
            if (end != 0L) break else continue
          }
          end = m.end
        }
        seen[base] = NativeImage(file, f.buildId, base, if (end > base) end - base else 0)
      }
      return seen.values.toList()
    }

    /**
     * `2026-11-04 03:44:53.013775285+0200`: debuggerd's `%F %H:%M:%S.%09ld%z`, local time with its
     * offset. Plain arithmetic (no java.time: the library's minSdk is 24).
     */
    fun parseTimestamp(s: String): Long? {
      val m = Regex("""^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([+-])(\d{2}):?(\d{2})$""").matchEntire(s.trim()) ?: return null
      val g = m.groupValues
      val days = daysFromCivil(g[1].toInt(), g[2].toInt(), g[3].toInt())
      val ms = (g[7].padEnd(9, '0').take(3).ifEmpty { "0" }).toLong()
      val offsetMin = (g[9].toInt() * 60 + g[10].toInt()) * if (g[8] == "-") -1 else 1
      val local = ((days * 24 + g[4].toInt()) * 60 + g[5].toInt()) * 60 + g[6].toInt()
      return (local - offsetMin * 60L) * 1000 + ms
    }

    /** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm). */
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
      val y = (if (month <= 2) year - 1 else year).toLong()
      val era = Math.floorDiv(y, 400L)
      val yoe = y - era * 400
      val mp = (month + 9) % 12
      val doy = (153 * mp + 2) / 5 + day - 1
      val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
      return era * 146097 + doe - 719468
    }

    /**
     * Sentry's debug id of an ELF: the build id's first 16 bytes (zero-padded) as a GUID whose first
     * three fields are little-endian, e.g. build id `1b9fecf8 34d6 10f7 7e64...` is
     * `f8ec9f1b-d634-f710-7e64-...`. Null when the build id is not hex.
     */
    fun debugId(buildId: String): String? {
      if (buildId.length < 2 || buildId.length % 2 != 0 || !buildId.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
      val b = ByteArray(16)
      for (i in 0 until minOf(16, buildId.length / 2)) b[i] = buildId.substring(2 * i, 2 * i + 2).toInt(16).toByte()
      val order = intArrayOf(3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15)
      val h = order.joinToString("") { "%02x".format(b[it].toInt() and 0xff) }
      return "${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}"
    }
  }
}

/** The NDK crash rule (mobile SDK spec C2, Android): pure, so the cases are tested. */
object NativeCrash {
  /**
   * The crash report of the previous run when it died of a native crash whose tombstone is readable
   * (Android 12+), else null. [exit] is the previous run's exit record, [tombstone] its trace
   * (`ApplicationExitInfo.getTraceInputStream()`); [crashReported]: the run left a JVM crash report,
   * which wins. When this returns a report, the termination rule must not run for the same exit
   * (one exit, one record): [Termination.decide] gets `crashReported = true`.
   */
  fun decide(previous: RunState?, exit: Exit?, tombstone: ByteArray?, crashReported: Boolean): Report? {
    if (crashReported || previous == null || exit == null || exit.pid != previous.pid) return null
    if (exit.reason != Termination.REASON_CRASH_NATIVE || tombstone == null) return null
    val t = Tombstone.parse(tombstone) ?: return null
    // The trace belongs to the exit's process; anything else is not this run's crash.
    if (t.pid != exit.pid) return null
    return t.toReport(previous, exit.timestampMs)
  }
}
