// A minified app to verify the R8 mapping id end to end (ADR-0027): applies gradle/ouo-mapping.gradle,
// crashes on demand through inlined Kotlin, and prints the report Signals wrote at the next launch.
// Not published. Build: ./gradlew :sample:assembleRelease (signed with the debug key).
plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "dev.ouo.sample"
  compileSdk = 35
  buildToolsVersion = "35.0.0"
  defaultConfig {
    applicationId = "dev.ouo.sample"
    minSdk = 24
    targetSdk = 35
    versionCode = 1
    versionName = "1.0"
  }
  buildTypes {
    release {
      isMinifyEnabled = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
      signingConfig = signingConfigs.getByName("debug")
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

apply(from = "../gradle/ouo-mapping.gradle")

dependencies {
  implementation(project(":signals"))
}
