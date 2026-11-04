// The Android side of the signals: the uncaught exception handler, the main-thread watchdog,
// ApplicationExitInfo terminations, FrameMetrics frame counters and the app start.
plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "dev.ouo.signals"
  compileSdk = 35
  buildToolsVersion = "35.0.0"
  defaultConfig {
    minSdk = 24
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
  api(project(":signals-core"))
}
