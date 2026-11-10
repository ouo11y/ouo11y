#!/bin/sh
# Creates the benchmark AVD (once). Android 35 google_apis arm64, pixel_7 profile, 4 GiB, 4 vCPU.
set -e
E=/opt/homebrew/share/android-commandlinetools
echo no | "$E/cmdline-tools/latest/bin/avdmanager" create avd -n ouo-step5-bench -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7 || true
C=~/.android/avd/ouo-step5-bench.avd/config.ini
for kv in hw.ramSize=4096 hw.gpu.enabled=yes hw.gpu.mode=swiftshader_indirect hw.cpu.ncore=4 hw.keyboard=no; do
  k=${kv%%=*}; sed -i '' "/^$k=/d" "$C"; echo "$kv" >> "$C"
done
