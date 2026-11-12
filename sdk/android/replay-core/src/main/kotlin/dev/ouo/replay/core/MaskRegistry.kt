package dev.ouo.replay.core

import java.util.concurrent.ConcurrentHashMap

/**
 * View-level masking set by the host at run time, by view id (a React tag in React Native):
 * [mask] and [unmask] are two sets, and a view in both is masked (mask wins). A secure input stays
 * masked whatever is set here (the walk marks it). Thread-safe and bounded: past [max] ids a new id
 * is not taken.
 */
class MaskRegistry(private val max: Int = 4096) {
  private val masked = ConcurrentHashMap<Int, Boolean>()
  private val unmasked = ConcurrentHashMap<Int, Boolean>()

  /** False when the id was not taken (the bound). */
  fun mask(id: Int): Boolean {
    if (masked.size >= max && !masked.containsKey(id)) return false
    masked[id] = true
    return true
  }

  fun unmask(id: Int): Boolean {
    if (unmasked.size >= max && !unmasked.containsKey(id)) return false
    unmasked[id] = true
    return true
  }

  /** Forgets both for [id] (its view is gone, or follows the rules again). */
  fun clear(id: Int) {
    masked.remove(id)
    unmasked.remove(id)
  }

  fun clearAll() {
    masked.clear()
    unmasked.clear()
  }

  /** True masked, false unmasked, null neither. */
  fun of(id: Int): Boolean? = if (masked.containsKey(id)) true else if (unmasked.containsKey(id)) false else null
}
