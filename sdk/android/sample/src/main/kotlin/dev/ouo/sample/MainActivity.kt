package dev.ouo.sample

import android.app.Activity
import android.os.Bundle
import android.util.Log
import dev.ouo.signals.Signals

/**
 * Logs the previous run's report (tag `ouo-sample`), then crashes when started with
 * `--ez crash true` through a chain R8 inlines (Checkout.pay -> Cart.total -> Prices.sum).
 */
class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Signals.init(this)
    Log.i("ouo-sample", "mapping_id=${Signals.mappingId() ?: "none"}")
    Signals.takePendingReport()?.let { Log.i("ouo-sample", "report=$it") }
    Signals.install("sample-session", System.currentTimeMillis()) {}
    if (intent.getBooleanExtra("crash", false)) {
      window.decorView.post { Checkout(Cart(listOf(3, -1))).pay() }
    }
  }
}

class Checkout(private val cart: Cart) {
  fun pay(): Int {
    val total = cart.total()
    return if (total > 0) total else 0
  }
}

class Cart(private val items: List<Int>) {
  fun total(): Int = Prices.sum(items)
}

object Prices {
  fun sum(items: List<Int>): Int {
    var s = 0
    for (i in items) s += check(i)
    return s
  }

  private fun check(price: Int): Int {
    if (price < 0) throw IllegalStateException("negative price $price")
    return price
  }
}
