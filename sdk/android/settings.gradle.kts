// ouo11y native Android SDK (roadmap W9). replay-core and signals-core are plain Kotlin on the JVM,
// unit tested without Android; replay (the screen capture) and signals (crashes, hangs,
// terminations, frames, app start) are their Android halves.
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
include(":replay-core", ":replay", ":signals-core", ":signals")
