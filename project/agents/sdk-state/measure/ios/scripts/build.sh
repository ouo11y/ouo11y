#!/bin/sh
# Generates and builds the three variants (base, ouo, sentry) of the harness app, Release.
#   scripts/build.sh <repo root> [sentry version, default 9.33.0]
# Outputs build/<variant>/{sim,dev}/Bench.app plus build/sizes.json (scripts/size.py).
set -eu
W=$(cd "$(dirname "$0")/.." && pwd)
REPO=$1
SENTRY=${2:-9.33.0}
B="$W/build"
mkdir -p "$B"
gen() { # <variant> <deps> <products> <define>
  D="$B/$1/pkg"
  rm -rf "$D/Sources" && mkdir -p "$D/Sources/Bench"
  cp "$W/app/App.swift" "$D/Sources/Bench/main.swift"
  cat > "$D/Package.swift" <<PKG
// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "Bench",
    platforms: [.iOS(.v15)],
    dependencies: [$2],
    targets: [
        .executableTarget(name: "Bench", dependencies: [$3], swiftSettings: [$4]),
    ]
)
PKG
}
gen base "" "" ""
gen ouo ".package(path: \"$REPO/sdk/ios\")" ".product(name: \"OuoSDK\", package: \"ios\")" '.define("OUO")'
gen sentry ".package(url: \"https://github.com/getsentry/sentry-cocoa\", exact: \"$SENTRY\")" ".product(name: \"Sentry\", package: \"sentry-cocoa\")" '.define("SENTRY")'

wrap() { # <variant> <products dir> <out app> <bundle id>
  APP=$3
  rm -rf "$APP" && mkdir -p "$APP"
  cp "$2/Bench" "$APP/"
  sed "s/__BUNDLE_ID__/$4/" "$W/app/Info.plist" > "$APP/Info.plist"
  for r in "$2"/*.bundle; do [ -e "$r" ] && cp -R "$r" "$APP/"; done
  if [ -d "$2/PackageFrameworks" ]; then mkdir -p "$APP/Frameworks"; cp -R "$2/PackageFrameworks/"*.framework "$APP/Frameworks/" 2>/dev/null || true; fi
  codesign --force --sign - "$APP" >/dev/null
}

for v in base ouo sentry; do
  D="$B/$v/pkg"
  (cd "$D" && perl -e 'alarm 1800; exec @ARGV' xcodebuild -quiet -scheme Bench -configuration Release \
    -destination "generic/platform=iOS Simulator" -derivedDataPath "$B/$v/dd-sim" -clonedSourcePackagesDirPath "$B/$v/dd-sim/SourcePackages" build)
  wrap $v "$B/$v/dd-sim/Build/Products/Release-iphonesimulator" "$B/$v/sim/Bench.app" "dev.step5.$v"
  (cd "$D" && perl -e 'alarm 1800; exec @ARGV' xcodebuild -quiet -scheme Bench -configuration Release \
    -destination "generic/platform=iOS" -derivedDataPath "$B/$v/dd-dev" -clonedSourcePackagesDirPath "$B/$v/dd-sim/SourcePackages" CODE_SIGNING_ALLOWED=NO build)
  wrap $v "$B/$v/dd-dev/Build/Products/Release-iphoneos" "$B/$v/dev/Bench.app" "dev.step5.$v"
done
python3 -I "$W/scripts/size.py" "$B" > "$B/sizes.json"
cat "$B/sizes.json"
