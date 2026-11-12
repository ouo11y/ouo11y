#!/usr/bin/env bash
# leak-run.sh <runs> <log>: launches mobile-store on emulator-5620 and drives screen transitions
# (push/pop of Product, modal Cart open/close, instant "tab" switch to Chaos and back), logging
# each transition's wall-clock time (epoch ms) so frames around it can be found.
set -euo pipefail
RUNS=${1:-10}; LOG=${2:-/dev/stdout}
ADB="/opt/homebrew/share/android-commandlinetools/platform-tools/adb -s emulator-5620"
cmd() { $ADB shell am broadcast -a dev.ouo.mobilestore.JOURNEY -p dev.ouo.mobilestore --es cmd "'$1'" >/dev/null; echo "$(perl -MTime::HiRes=time -e 'printf "%d", time*1000') $2 $1" >> "$LOG"; sleep "${3:-2.5}"; }
$ADB shell am force-stop dev.ouo.mobilestore
$ADB shell am start -n dev.ouo.mobilestore/.MainActivity >/dev/null
sleep 8
for r in $(seq 1 "$RUNS"); do
  id=p-100$(( (r % 4) + 1 ))
  cmd "screen/Product?id=$id" "push"
  cmd "screen/back" "pop"
  cmd "screen/Cart" "modal-open"
  cmd "screen/back" "modal-close"
  cmd "screen/Chaos" "tab-switch"
  cmd "screen/back" "tab-back"
done
cmd "action/flush" "flush" 3
$ADB shell input keyevent KEYCODE_HOME
echo "$(perl -MTime::HiRes=time -e 'printf "%d", time*1000') background -" >> "$LOG"
sleep 8
