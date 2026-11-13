// The part of sentry-java's session-replay recorder the `pixel/video` recorder uses (MIT, see
// ../NOTICE): src/main/upstream is copied by scripts/sentry-core-sync.sh and never edited;
// src/main/kotlin holds the seams it needs from the Sentry SDK and the ouo driver.
plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "dev.ouo.sentrycore"
  compileSdk = 35
  buildToolsVersion = "35.0.0"
  defaultConfig {
    minSdk = 24
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  sourceSets {
    getByName("main") {
      java.srcDirs("src/main/kotlin", "src/main/upstream")
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  androidTestImplementation("androidx.test:core:1.6.1")
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("junit:junit:4.13.2")
}
