package dev.ouo.replay.core

/**
 * The one place a recorder asks "did the host mask or unmask this view?" (ADR-0021 decision 5:
 * every pixel recorder masks identically). It answers for both ways a host says it:
 *
 * - the view tags `ouo-mask` and `ouo-unmask` (React Native `testID`, or `view.tag` in a native app);
 * - React Native's `mask(reactTag)` / `unmask(reactTag)`, kept here by tag (the view's id).
 *
 * It does not depend on a recorder: the frames recorder reads it on every walk, and another
 * recorder reads the same snapshot. For one view, a mask wins over an unmask; for a tag, the last
 * call decides which set it is in. What an override means in a tree (a mask inside an unmasked
 * subtree still masks, a secure field is masked whatever is said here: PRV-6, PRV-7) is the
 * redaction planner's, under [RedactionRules.strict]. Thread-safe. The Swift
 * `ReplayMaskRegistry` of `sdk/ios`, ported.
 *
 * Bounded (ERR-9) and fail closed: each set keeps at most [LIMIT] tags. A refused unmask leaves the
 * view masked, the safe side. A mask is never refused: once the masked set is full the registry is
 * saturated, and until [reset] every view with a React tag is masked (the React root has one, so
 * the whole React screen is covered) and no unmask by tag is honoured.
 */
class ReplayMaskRegistry {
  /** What a walk reads: the two tag sets as they were when it started. [saturated]: a mask came when the masked set was full, every tagged view is masked. */
  data class Snapshot(val masked: Set<Int> = emptySet(), val unmasked: Set<Int> = emptySet(), val saturated: Boolean = false) {
    /** The host's override for one view, from its React tag (null for a view that has none) and its string tag: true masks, false unmasks, null neither. Mask wins. */
    fun override(reactTag: Int?, tag: String?): Boolean? {
      if (tag == RedactionRules.MASK_TAG) return true
      if (reactTag != null && (saturated || reactTag in masked)) return true
      if (tag == RedactionRules.UNMASK_TAG) return false
      if (reactTag != null && reactTag in unmasked) return false
      return null
    }
  }

  private val lock = Any()
  private val masked = HashSet<Int>()
  private val unmasked = HashSet<Int>()
  /** The sets as an immutable copy, made at most once per change. */
  private var cached: Snapshot? = Snapshot()
  private var saturated = false
  private var refusedCount = 0

  fun mask(reactTag: Int): Unit = synchronized(lock) {
    unmasked.remove(reactTag)
    if (reactTag in masked || masked.size < LIMIT) {
      masked.add(reactTag)
    } else {
      // Fail closed: the tag cannot be kept, so every tagged view is masked.
      refusedCount++
      saturated = true
    }
    cached = null
  }

  fun unmask(reactTag: Int): Unit = synchronized(lock) {
    masked.remove(reactTag)
    if (reactTag in unmasked || unmasked.size < LIMIT) unmasked.add(reactTag) else refusedCount++
    cached = null
  }

  /** Forgets every tag (a JavaScript reload hands out tags again). */
  fun reset(): Unit = synchronized(lock) {
    masked.clear()
    unmasked.clear()
    saturated = false
    cached = null
  }

  fun snapshot(): Snapshot = synchronized(lock) { cached ?: Snapshot(HashSet(masked), HashSet(unmasked), saturated).also { cached = it } }

  /** Calls refused because a set was full (a refused mask saturates the registry). */
  val refused: Int get() = synchronized(lock) { refusedCount }

  companion object {
    val shared = ReplayMaskRegistry()

    /** Tags kept per set (ERR-9). */
    const val LIMIT = 10_000
  }
}
