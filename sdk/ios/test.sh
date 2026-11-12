#!/bin/sh
# Runs the OuoReplayCore tests. With a full Xcode, plain `swift test` works. With only the
# Command Line Tools there is no XCTest, but Swift Testing ships inside the CLT
# (Library/Developer/Frameworks/Testing.framework + Library/Developer/usr/lib), which
# SwiftPM does not search by default; this script points the compiler, linker and dyld there.
# See project/kb-archive/xcode-setup.md.
#
# `test.sh --uikit <simulator udid>` runs the UIKit tests instead (OuoReplayUIKitTests: the masking
# plan of both pixel recorders and the video core's mask), with xcodebuild on that simulator.
set -eu
cd "$(dirname "$0")"
if [ "${1:-}" = "--uikit" ]; then
  exec xcodebuild test -quiet -scheme ouo11y-ios-Package -destination "id=${2:?usage: test.sh --uikit <simulator udid>}" \
    -derivedDataPath .build/xcode-uikit -only-testing:OuoReplayUIKitTests
fi
DEV="$(xcode-select -p)"
case "$DEV" in
  *Xcode.app*) exec swift test "$@" ;;
esac
F="$DEV/Library/Developer/Frameworks"
L="$DEV/Library/Developer/usr/lib"
exec swift test --disable-xctest --enable-swift-testing \
  -Xswiftc -F"$F" -Xlinker -F"$F" -Xlinker -rpath -Xlinker "$F" -Xlinker -rpath -Xlinker "$L" "$@"
