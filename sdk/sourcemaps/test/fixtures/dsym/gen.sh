#!/usr/bin/env bash
# Regenerates crashy.dwarf, the DWARF file of crashy.dSYM for arm64 and x86_64 (macOS with
# Xcode command line tools). Paths are mapped to /src so the fixture names no local directory.
# The UUIDs in ../../sourcemaps.test.ts come from the dwarfdump line this prints; update them after
# a regeneration.
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
clang -g -O1 -arch arm64 -arch x86_64 -fdebug-prefix-map="$PWD=/src" -c crashy.c -o "$tmp/crashy.o"
clang -arch arm64 -arch x86_64 "$tmp/crashy.o" -o "$tmp/crashy"
dsymutil "$tmp/crashy" -o "$tmp/crashy.dSYM"
cp "$tmp/crashy.dSYM/Contents/Resources/DWARF/crashy" crashy.dwarf
dwarfdump --uuid crashy.dwarf
objdump --arch=arm64 -d --no-show-raw-insn "$tmp/crashy" | grep -E '^_|str	w8, \[x0\]|bl	_(crash_here|level1)'
