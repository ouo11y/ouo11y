plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

val sentryVersion = "8.63.0"

android {
  namespace = "bench"
  compileSdk = 35
  buildToolsVersion = "35.0.0"
  defaultConfig {
    applicationId = "dev.ouo.bench"
    minSdk = 24
    targetSdk = 35
    versionCode = 1
    versionName = "1.0"
    ndk { abiFilters += "arm64-v8a" }
  }
  flavorDimensions += "sdk"
  productFlavors {
    create("baseline") { dimension = "sdk"; applicationIdSuffix = ".baseline" }
    create("ouosignals") { dimension = "sdk"; applicationIdSuffix = ".ouosignals" }
    create("ouofull") { dimension = "sdk"; applicationIdSuffix = ".ouofull" }
    create("sentrycore") { dimension = "sdk"; applicationIdSuffix = ".sentrycore" }
    create("sentryreplay") { dimension = "sdk"; applicationIdSuffix = ".sentryreplay" }
    create("sentryfull") { dimension = "sdk"; applicationIdSuffix = ".sentryfull" }
  }
  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.getByName("debug")
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  lint { checkReleaseBuilds = false }
}

dependencies {
  // OkHttp in every variant (baseline too): the app's own HTTP client, so Sentry's OkHttp
  // integration has something to instrument and the size delta excludes OkHttp itself.
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  "ouosignalsImplementation"(project(":signals"))
  "ouofullImplementation"(project(":signals"))
  "ouofullImplementation"(project(":replay"))
  "sentrycoreImplementation"("io.sentry:sentry-android-core:$sentryVersion")
  "sentrycoreImplementation"("io.sentry:sentry-okhttp:$sentryVersion")
  "sentryreplayImplementation"("io.sentry:sentry-android-core:$sentryVersion")
  "sentryreplayImplementation"("io.sentry:sentry-android-replay:$sentryVersion")
  "sentryreplayImplementation"("io.sentry:sentry-okhttp:$sentryVersion")
  "sentryfullImplementation"("io.sentry:sentry-android:$sentryVersion")
  "sentryfullImplementation"("io.sentry:sentry-okhttp:$sentryVersion")
}
