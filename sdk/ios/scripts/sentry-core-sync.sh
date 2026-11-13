#!/bin/sh
# Vendors, checks and diffs the session-replay recorder core copied from getsentry/sentry-cocoa
# (MIT) into Sources/OuoReplaySentryCore{,ObjC}. See project/kb/session-replay/borrowing/.
#
#   sentry-core-sync.sh check          our copy == pinned tag + the transforms below (CI-able)
#   sentry-core-sync.sh diff <tag>     what upstream changed in the copied files between the pin and <tag>,
#                                      plus new files in the upstream replay/view-capture folders
#   sentry-core-sync.sh vendor <tag>   re-copy the files from <tag> and move the pin (review the diff after)
#
# Transforms applied to every copied file, nothing else:
#   1. a header naming the tag, the upstream path and the MIT notice;
#   2. `internal import _SentryPrivate` -> `import OuoReplaySentryCoreObjC` (Sentry's private module);
#   3. SentryObjCExceptionHelper.h: an `objc_runtime_name` so the ObjC class cannot clash with a
#      real Sentry SDK linked into the same app.
# The Sentry seams (log, queues, mutex-free date provider, run-loop observer typealiases) are
# re-implemented in Sources/OuoReplaySentryCore/Seams.swift; the ouo driver is SentryCoreRecorder.swift.
set -eu
cd "$(dirname "$0")/.."
REPO=https://github.com/getsentry/sentry-cocoa.git
CORE=Sources/OuoReplaySentryCore
OBJC=Sources/OuoReplaySentryCoreObjC
PIN=$(cat "$CORE/UPSTREAM_TAG")

SWIFT_FILES="
Sources/Swift/Core/Protocol/SentryRedactOptions.swift
Sources/Swift/Core/Tools/ViewCapture/SentryDefaultMaskRenderer.swift
Sources/Swift/Core/Tools/ViewCapture/SentryDefaultViewRenderer.swift
Sources/Swift/Core/Tools/ViewCapture/SentryGraphicsImageRenderer.swift
Sources/Swift/Core/Tools/ViewCapture/SentryMaskRenderer.swift
Sources/Swift/Core/Tools/ViewCapture/SentryMaskRendererV2.swift
Sources/Swift/Core/Tools/ViewCapture/SentryRedactRegion.swift
Sources/Swift/Core/Tools/ViewCapture/SentryRedactRegionType.swift
Sources/Swift/Core/Tools/ViewCapture/SentryRedactViewHelper.swift
Sources/Swift/Core/Tools/ViewCapture/SentryUIRedactBuilder.swift
Sources/Swift/Core/Tools/ViewCapture/SentryViewPhotographer.swift
Sources/Swift/Core/Tools/ViewCapture/SentryViewRenderer.swift
Sources/Swift/Core/Tools/ViewCapture/SentryViewRendererV2.swift
Sources/Swift/Core/Tools/ViewCapture/SentryViewScreenshotProvider.swift
Sources/Swift/Core/Tools/ViewCapture/SentryViewSubtreeTraversal.swift
Sources/Swift/Concurrency/SentryMutex.swift
Sources/Swift/Core/Helper/AssociatedObjectAccessor.swift
Sources/Swift/Core/Tools/UIImageHelper.swift
Sources/Swift/Integrations/SessionReplay/SentryOnDemandReplay.swift
Sources/Swift/Integrations/SessionReplay/SentryOnDemandReplayError.swift
Sources/Swift/Integrations/SessionReplay/SentryPixelBuffer.swift
Sources/Swift/Integrations/SessionReplay/SentryRenderVideoResult.swift
Sources/Swift/Integrations/SessionReplay/SentryReplayFrame.swift
Sources/Swift/Integrations/SessionReplay/SentryReplayVideoMaker.swift
Sources/Swift/Integrations/SessionReplay/SentrySessionReplayCaptureGuard.swift
Sources/Swift/Integrations/SessionReplay/SentrySessionReplayRunLoopCaptureScheduler.swift
Sources/Swift/Integrations/SessionReplay/SentryVideoFrameProcessor.swift
Sources/Swift/Integrations/SessionReplay/SentryVideoInfo.swift
"
OBJC_FILES="
Sources/Sentry/SentryObjCExceptionHelper.m
Sources/Sentry/include/SentryObjCExceptionHelper.h
"
# Upstream folders watched for new files by `diff`.
WATCH="Sources/Swift/Core/Tools/ViewCapture Sources/Swift/Integrations/SessionReplay"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/sentry-core.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fetch() { # tag -> $TMP/<tag>
  [ -d "$TMP/$1" ] && return
  git clone -q --depth 1 --branch "$1" "$REPO" "$TMP/$1" 2>/dev/null
}

header() { # tag upstream-path
  printf '%s\n' \
    "// Copied from getsentry/sentry-cocoa $1, $2." \
    "// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES." \
    "// Do not edit: re-vendor with sdk/ios/scripts/sentry-core-sync.sh; ouo code lives outside Upstream/." \
    ""
}

transform() { # tag upstream-path src dst
  { header "$1" "$2"
    sed -e 's/^internal import _SentryPrivate$/import OuoReplaySentryCoreObjC/' \
        -e 's/^@interface SentryObjCExceptionHelper : NSObject$/__attribute__((objc_runtime_name("OuoSentryCoreObjCExceptionHelper")))\
@interface SentryObjCExceptionHelper : NSObject/' "$3"
  } > "$4"
}

dest() { # upstream-path out-root -> destination path
  case "$1" in
    *.swift) echo "$2/$CORE/Upstream/$(basename "$1")" ;;
    *.h) echo "$2/$OBJC/include/$(basename "$1")" ;;
    *) echo "$2/$OBJC/$(basename "$1")" ;;
  esac
}

vendor_into() { # tag out-root
  fetch "$1"
  for f in $SWIFT_FILES $OBJC_FILES; do
    d=$(dest "$f" "$2"); mkdir -p "$(dirname "$d")"
    transform "$1" "$f" "$TMP/$1/$f" "$d"
  done
}

case "${1:-}" in
  check)
    vendor_into "$PIN" "$TMP/out"
    status=0
    for f in $SWIFT_FILES $OBJC_FILES; do
      diff -u "$(dest "$f" "$TMP/out")" "$(dest "$f" .)" || status=1
    done
    [ $status = 0 ] && echo "ok: $CORE matches sentry-cocoa $PIN plus the documented transforms"
    exit $status ;;
  diff)
    new=${2:?usage: diff <tag>}
    fetch "$PIN"; fetch "$new"
    for f in $SWIFT_FILES $OBJC_FILES; do
      if [ ! -f "$TMP/$new/$f" ]; then echo "REMOVED upstream: $f"; continue; fi
      diff -u --label "$PIN/$f" --label "$new/$f" "$TMP/$PIN/$f" "$TMP/$new/$f" || true
    done
    for w in $WATCH; do
      (cd "$TMP/$new" && find "$w" -name '*.swift') | while read -r f; do
        [ -f "$TMP/$PIN/$f" ] || echo "NEW upstream (not copied): $f"
      done
    done ;;
  vendor)
    new=${2:?usage: vendor <tag>}
    vendor_into "$new" .
    echo "$new" > "$CORE/UPSTREAM_TAG"
    echo "vendored sentry-cocoa $new; review git diff, then run test.sh and the simulator build" ;;
  *) sed -n 2,9p "$0"; exit 2 ;;
esac
