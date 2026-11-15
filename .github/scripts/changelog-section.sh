#!/usr/bin/env sh
# Prints the section of a package CHANGELOG.md for one version, without its heading.
# Usage: .github/scripts/changelog-section.sh <CHANGELOG.md> <version>
#
# Understands both heading styles in this repo:
#   ## 0.3.0 (2026-10-18)                       hand-written (Keep a Changelog)
#   ## 0.2.0 - unreleased
#   ## 0.7.0 (breaking: ...)
#   ## [0.4.0](https://github.com/...) (2026-11-02)   written by release-please
# Prints nothing (exit 0) when the file or the section does not exist.
set -eu
file="$1"
version="$2"
[ -f "$file" ] || exit 0
awk -v v="$version" '
  /^## / {
    h = $2
    gsub(/^\[/, "", h)
    gsub(/\].*$/, "", h)
    show = (h == v)
    next
  }
  show { print }
' "$file"
