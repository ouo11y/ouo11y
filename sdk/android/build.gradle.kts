// Versions follow React Native 0.86 (node_modules/react-native/gradle/libs.versions.toml), so the
// React Native module, which compiles these sources inside the app's build, sees the same Kotlin.
plugins {
  id("com.android.library") version "8.12.0" apply false
  id("org.jetbrains.kotlin.android") version "2.1.20" apply false
  id("org.jetbrains.kotlin.jvm") version "2.1.20" apply false
}
