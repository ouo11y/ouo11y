// Plain Kotlin, no Android: the replay rules that need no view system, tested on the JVM.
plugins {
  id("org.jetbrains.kotlin.jvm")
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  // org.json is part of the Android platform; on the JVM the tests bring their own copy.
  compileOnly("org.json:json:20250517")
  testImplementation("org.json:json:20250517")
  testImplementation("junit:junit:4.13.2")
}
