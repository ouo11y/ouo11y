#!/usr/bin/env bash
# Release build of examples/sentry-mobile for the benchmark (docs/benchmarks.md): OUO_PERF=1, every SDK
# endpoint on the counting proxy's ports (bench.py LISTEN), a linker map and a JS source map for the
# size attribution (size.py). Copies sentrydemo.app, its dSYM, the link map and the bundle's source map
# to <out>.
#
#   scripts/perf/build.sh --out <dir> [--target sim|device] [--device <udid>] [--team <TEAM_ID>]
#                         [--host <ip>] [--ouo workspace|<npm version>|<path to an sdk/react-native checkout>]
#                         [--sentry pinned|latest|<version>]
#
# --target device signs with --team (Automatic signing, -allowProvisioningUpdates) and bakes in --host
# (default: this Mac's LAN IP), since a phone cannot reach the Mac's loopback. --ouo / --sentry install
# those SDK versions into node_modules for this build (`pinned` and `workspace`: what package.json
# says); the versions used are written to <out>/versions.json and recorded again by bench.py.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
APP_DIR="$PWD"
OUT=""; TARGET=sim; DEVICE="${SIM_UDID:-A99B6BF8-6975-4407-9B59-D38066523B15}"; TEAM=""; HOST=""; OUO=workspace; SENTRY=pinned
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift ;;
    --target) TARGET="$2"; shift ;;
    --device) DEVICE="$2"; shift ;;
    --team) TEAM="$2"; shift ;;
    --host) HOST="$2"; shift ;;
    --ouo) OUO="$2"; shift ;;
    --sentry) SENTRY="$2"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$OUT" ]] || { echo "--out is required" >&2; exit 2; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 SENTRY_DISABLE_AUTO_UPLOAD=true CI=1
log() { printf '%s [build] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ $TARGET == device ]]; then
  [[ -n "$TEAM" ]] || { echo "--team is required for --target device" >&2; exit 2; }
  HOST=${HOST:-$(ipconfig getifaddr en0 || ipconfig getifaddr en1)}
else
  HOST=${HOST:-localhost}
fi

[[ -d node_modules ]] || npm ci --no-audit --no-fund
# SDK versions for this build. `npm install --no-save` keeps package.json and the lockfile as they are.
pkgs=()
if [[ -d $OUO ]]; then
  pkgs+=("$(cd "$OUO" && pwd)")   # an older release's source (a worktree at its tag), built
elif [[ $OUO != workspace ]]; then
  pkgs+=("@ouo11y/react-native@$OUO")
fi
case "$SENTRY" in
  pinned) ;;
  latest) SENTRY=$(npm view @sentry/react-native version) ;;
esac
if [[ $SENTRY != pinned ]]; then
  # The app pins @sentry/core too (a direct dependency): move it to the version this
  # @sentry/react-native depends on, as a customer upgrading would, or the bundle holds two copies.
  core=$(npm view "@sentry/react-native@$SENTRY" dependencies --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)["@sentry/core"]))')
  pkgs+=("@sentry/react-native@$SENTRY" "@sentry/core@$core")
fi
if [[ ${#pkgs[@]} -gt 0 ]]; then
  log "npm install --no-save ${pkgs[*]}"
  npm install --no-save --no-audit --no-fund "${pkgs[@]}"
fi

# Every SDK endpoint goes through the proxy (bench.py LISTEN). Both DSNs on the same port, so the
# `sentry` cell's traffic takes the same path whatever the mode.
export OUO_PERF=1 APP_VERSION=1.0.0 BUILD_NUMBER=1
export SENTRY_DSN="http://publickey0000000000000000000000@$HOST:4720/1"
export SENTRY_DIRECT_DSN="$SENTRY_DSN"
export BACKEND_URL="http://$HOST:4781" OUO_OTLP_ENDPOINT="http://$HOST:4718"
# The JS bundle's source map, written by react-native-xcode.sh (size.py attributes bundle bytes per package).
export SOURCEMAP_FILE="$OUT/main.jsbundle.map"

log "expo prebuild (clean)"
npx expo prebuild --platform ios --clean --no-install >"$OUT/prebuild.log" 2>&1
log "pod install"
(cd ios && pod install) >"$OUT/pod.log" 2>&1
WORKSPACE=$(ls -d ios/*.xcworkspace | head -1)
SCHEME=$(basename "$WORKSPACE" .xcworkspace)
DERIVED="$APP_DIR/ios/build/DerivedData"
args=(-workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release -derivedDataPath "$DERIVED"
  ONLY_ACTIVE_ARCH=YES LD_GENERATE_MAP_FILE=YES 'LD_MAP_FILE_PATH=$(TARGET_TEMP_DIR)/linkmap-$(CURRENT_ARCH).txt'
  DEBUG_INFORMATION_FORMAT=dwarf-with-dsym)
if [[ $TARGET == device ]]; then
  args+=(-sdk iphoneos -destination "id=$DEVICE" -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic)
  PRODUCTS="$DERIVED/Build/Products/Release-iphoneos"
else
  args+=(-sdk iphonesimulator -destination "id=$DEVICE" CODE_SIGNING_ALLOWED=NO)
  PRODUCTS="$DERIVED/Build/Products/Release-iphonesimulator"
fi
log "xcodebuild $SCHEME Release ($TARGET, endpoints on $HOST)"
xcodebuild "${args[@]}" build >"$OUT/xcodebuild.log" 2>&1 || { log "build failed: $OUT/xcodebuild.log"; tail -30 "$OUT/xcodebuild.log"; exit 1; }
rm -rf "$OUT/sentrydemo.app" "$OUT/sentrydemo.app.dSYM"
cp -R "$PRODUCTS/$SCHEME.app" "$OUT/sentrydemo.app"
[[ -d "$PRODUCTS/$SCHEME.app.dSYM" ]] && cp -R "$PRODUCTS/$SCHEME.app.dSYM" "$OUT/sentrydemo.app.dSYM"
cp ios/Podfile.lock "$OUT/Podfile.lock"
# The app target's link map (arm64: the device, and the simulator on Apple silicon).
find "$DERIVED/Build/Intermediates.noindex/$SCHEME.build" -name 'linkmap-arm64.txt' -exec cp {} "$OUT/linkmap.txt" \;
node -e '
const v = (n) => { try { return require(`./node_modules/${n}/package.json`).version } catch { return null } };
const o = { target: process.argv[1], host: process.argv[2] };
for (const n of ["@ouo11y/react-native", "@sentry/react-native", "@sentry/core", "react-native", "expo"]) o[n] = v(n);
require("fs").writeFileSync(process.argv[3], JSON.stringify(o, null, 1));
' "$TARGET" "$HOST" "$OUT/versions.json"
log "built $OUT/sentrydemo.app ($(cat "$OUT/versions.json" | tr -d '\n '))"
