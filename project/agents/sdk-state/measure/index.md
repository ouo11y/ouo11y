# sdk-state measurement harnesses

One harness per platform, each comparing ouo with Sentry on the same app and journey. Each folder has a README with the exact commands and a `results/` folder (or `results.json`) with the raw numbers the report uses.

| Folder | What it measures |
|---|---|
| [web/](web/README.md) | Bundle sizes (gzip, brotli), init, main-thread and renderer CPU, heap, interaction task time, bytes per minute, in headless Chromium; OTLP JSON against protobuf |
| [react-native/](react-native/README.md) | JavaScript bundle size of the React Native SDKs |
| [ios/](ios/README.md) | App size added, init, CPU, memory and bytes per minute on the iOS Simulator |
| [android/](android/README.md) | App size added, init, CPU, memory and bytes per minute on an Android emulator |
