// Copied from getsentry/sentry-java 8.64.0, sentry-android-replay/src/main/java/io/sentry/android/replay/util/SystemProperties.kt.
// Copyright (c) 2019 Sentry. MIT License, see sdk/android/NOTICE.
// Do not edit: re-vendor with sdk/android/scripts/sentry-core-sync.sh; ouo code lives in src/main/kotlin.

package dev.ouo.sentrycore.android.replay.util

import android.os.Build

internal object SystemProperties {
  enum class Property {
    SOC_MODEL,
    SOC_MANUFACTURER,
  }

  fun get(key: Property, defaultValue: String = ""): String =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      when (key) {
        Property.SOC_MODEL -> Build.SOC_MODEL
        Property.SOC_MANUFACTURER -> Build.SOC_MANUFACTURER
      }
    } else {
      defaultValue
    }
}
