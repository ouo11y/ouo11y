#!/bin/sh
# Builds the example for the iOS simulator and wraps the SwiftPM executable into OuoExample.app:
# the binary, Info.plist, the SDK's resource bundle (privacy manifest), signed ad hoc.
# Usage: scripts/build.sh <out dir>   (prints the .app path)
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=$1
(cd "$HERE" && xcodebuild -quiet -scheme OuoExample -configuration Release \
  -destination "generic/platform=iOS Simulator" -derivedDataPath "$OUT/dd" build)
P="$OUT/dd/Build/Products/Release-iphonesimulator"
APP="$OUT/OuoExample.app"
rm -rf "$APP" && mkdir -p "$APP"
cp "$P/OuoExample" "$APP/" && cp "$HERE/Info.plist" "$APP/Info.plist"
cp -R "$P/ouo11y-ios_OuoSDK.bundle" "$APP/"
codesign --force --sign - "$APP" >/dev/null
echo "$APP"
