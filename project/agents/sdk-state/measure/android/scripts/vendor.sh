#!/bin/sh
# Copies the four sdk/android modules (build file + src/main) into host/vendor, unchanged, plus the
# Gradle wrapper. usage: vendor.sh <repo root>
set -e
R=$1; H=$(cd "$(dirname "$0")/../host" && pwd)
for m in replay-core replay signals-core signals; do
  rm -rf "$H/vendor/$m"; mkdir -p "$H/vendor/$m/src"
  cp "$R/sdk/android/$m/build.gradle.kts" "$H/vendor/$m/"
  cp -R "$R/sdk/android/$m/src/main" "$H/vendor/$m/src/"
done
cp -R "$R/sdk/android/gradle" "$R/sdk/android/gradlew" "$R/sdk/android/gradle.properties" "$H/"
