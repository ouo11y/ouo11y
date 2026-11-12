#!/bin/sh
# Vendors, checks and diffs the part of getsentry/sentry-java's session-replay recorder
# (sentry-android-replay, MIT) that the `pixel/video` recorder uses, into
# replay-sentry-core/src/main/upstream. See project/kb/session-replay/borrowing/sentry-android-video-over-otlp.md.
#
#   sentry-core-sync.sh check          our copy == pinned tag + the transforms below (CI-able)
#   sentry-core-sync.sh diff <tag>     what upstream changed in the copied files between the pin and <tag>,
#                                      plus new files in the upstream video/ folder
#   sentry-core-sync.sh vendor <tag>   re-copy the files from <tag> and move the pin (review the diff after)
#
# Transforms applied to every copied file, nothing else:
#   1. a header naming the tag, the upstream path and the MIT notice;
#   2. the package prefix `io.sentry.` -> `dev.ouo.sentrycore.` (package lines and imports), so the
#      copy cannot clash with a real Sentry SDK in the same app.
# What the copy needs from the Sentry SDK (SentryOptions, its logger, SentryLevel) is re-implemented
# in replay-sentry-core/src/main/kotlin/dev/ouo/sentrycore/Seams.kt; the ouo driver is Mp4SegmentWriter.kt.
set -eu
cd "$(dirname "$0")/.."
REPO=https://github.com/getsentry/sentry-java.git
CORE=replay-sentry-core
UP=$CORE/src/main/upstream
PIN=$(cat "$CORE/UPSTREAM_TAG")
SRC=sentry-android-replay/src/main/java/io/sentry/android/replay

FILES="
$SRC/video/SimpleVideoEncoder.kt
$SRC/video/SimpleMp4FrameMuxer.kt
$SRC/video/SimpleFrameMuxer.kt
$SRC/util/SystemProperties.kt
"
# Upstream folders watched for new files by `diff`.
WATCH="$SRC/video"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/sentry-java-core.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fetch() { # tag -> $TMP/<tag>, a fresh shallow clone
  [ -d "$TMP/$1" ] && return
  git clone -q --depth 1 --branch "$1" "$REPO" "$TMP/$1" 2>/dev/null
}

header() { # tag upstream-path
  printf '%s\n' \
    "// Copied from getsentry/sentry-java $1, $2." \
    "// Copyright (c) 2019 Sentry. MIT License, see sdk/android/NOTICE." \
    "// Do not edit: re-vendor with sdk/android/scripts/sentry-core-sync.sh; ouo code lives in src/main/kotlin." \
    ""
}

transform() { # tag upstream-path src dst
  { header "$1" "$2"
    sed -e 's/io\.sentry\./dev.ouo.sentrycore./g' "$3"
  } > "$4"
}

dest() { # upstream-path out-root -> destination path
  rel=${1#"$SRC"/}
  echo "$2/$UP/dev/ouo/sentrycore/android/replay/$rel"
}

vendor_into() { # tag out-root
  fetch "$1"
  for f in $FILES; do
    d=$(dest "$f" "$2"); mkdir -p "$(dirname "$d")"
    transform "$1" "$f" "$TMP/$1/$f" "$d"
  done
}

case "${1:-}" in
  check)
    vendor_into "$PIN" "$TMP/out"
    status=0
    for f in $FILES; do
      diff -u "$(dest "$f" "$TMP/out")" "$(dest "$f" .)" || status=1
    done
    # Nothing in upstream/ that the list does not name.
    extra=$(cd "$UP" && find . -type f | sort | while read -r p; do
      found=0; for f in $FILES; do [ "./dev/ouo/sentrycore/android/replay/${f#"$SRC"/}" = "$p" ] && found=1; done
      [ $found = 1 ] || echo "$p"; done)
    [ -z "$extra" ] || { echo "not from the list: $extra"; status=1; }
    [ $status = 0 ] && echo "ok: $UP matches sentry-java $PIN plus the documented transforms"
    exit $status ;;
  diff)
    new=${2:?usage: diff <tag>}
    fetch "$PIN"; fetch "$new"
    for f in $FILES; do
      if [ ! -f "$TMP/$new/$f" ]; then echo "REMOVED upstream: $f"; continue; fi
      diff -u --label "$PIN/$f" --label "$new/$f" "$TMP/$PIN/$f" "$TMP/$new/$f" || true
    done
    for w in $WATCH; do
      (cd "$TMP/$new" && find "$w" -name '*.kt') | while read -r f; do
        [ -f "$TMP/$PIN/$f" ] || echo "NEW upstream (not copied): $f"
      done
    done ;;
  vendor)
    new=${2:?usage: vendor <tag>}
    vendor_into "$new" .
    echo "$new" > "$CORE/UPSTREAM_TAG"
    echo "vendored sentry-java $new; review git diff, then run the unit tests and connectedAndroidTest of $CORE" ;;
  *) sed -n 2,10p "$0"; exit 2 ;;
esac
