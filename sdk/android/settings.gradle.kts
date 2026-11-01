// ouo11y native Android SDK (roadmap W9). replay-core is plain Kotlin on the JVM (chunks, tile diff,
// pacing, spool, disk queue, upload), unit tested without Android; replay is the Android capture.
// The React Native module compiles the same sources (sdk/react-native/scripts/sync-android.mjs).
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
  }
}
rootProject.name = "ouo11y-android"
include(":replay-core", ":replay")
