# R8 fixture

Built from `sdk/android/sample` (R8 8.12.14, AGP 8.12.0) on 2026-11-15 with
`./gradlew :sample:assembleRelease`, then run on an Android 15 emulator with
`am start -n dev.ouo.sample/.MainActivity --ez crash true` and started again.

- `mapping.txt`: `sample/build/outputs/mapping/release/mapping.txt` of that build (mapping id `fc5959f4-0d6c-4bb9-8edf-9788fbd76af1`).
- `report.json`: the crash report `Signals` wrote, as the next launch read it (`Signals.takePendingReport()`).
- `stack-obfuscated.txt`: the top of the crash as logcat printed it.
- `stack-retrace.txt`: R8's own `retrace` (cmdline-tools) on `stack-obfuscated.txt`, the expected output.
