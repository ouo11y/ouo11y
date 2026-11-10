// Step 5 overhead harness: one tiny native host app, one product flavor per SDK variant.
// The ouo modules are copied from sdk/android (vendor/, see ../scripts/vendor.sh) so the repo stays untouched.
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "ouo-step5-android-bench"
include(":app", ":replay-core", ":replay", ":signals-core", ":signals")
listOf("replay-core", "replay", "signals-core", "signals").forEach { project(":$it").projectDir = file("vendor/$it") }
