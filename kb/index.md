# Knowledge base

One file per topic. Add a line here whenever you add a file. Each entry answers a concrete question and records what was tried.

| File | Question it answers |
|---|---|
| [otel-browser-sdk.md](otel-browser-sdk.md) | How the OTel JS web SDK is wired for sessions, fetch tracing and events (filled in Phase 2) |
| [otel-react-native.md](otel-react-native.md) | What the OTel JS SDK needs to run inside React Native / Expo (filled in Phase 5) |
| [collector-lgtm.md](collector-lgtm.md) | Collector config that forwards OTLP to Loki, Tempo and Mimir with browser CORS (filled in Phase 1) |
| [loki-session-queries.md](loki-session-queries.md) | LogQL used by rum-api to fold session events (filled in Phase 3) |
| [tempo-session-search.md](tempo-session-search.md) | TraceQL and Tempo API used to list traces per session (filled in Phase 3) |
| [rrweb-chunking.md](rrweb-chunking.md) | rrweb record/replay settings, chunk sizes, privacy classes (filled in Phase 2) |
| [grafana-app-plugin.md](grafana-app-plugin.md) | Scaffold, unsigned plugin loading, route proxy, embedding rrweb-player (filled in Phase 4) |
| [competitors.md](competitors.md) | Notes on how Sentry, Datadog, Grafana Faro, PostHog and OpenReplay model sessions and replay |
| [otel-go-baggage.md](otel-go-baggage.md) | How the Go demo backend copies baggage `session.id` onto spans and logs; otelhttp route naming, otelslog bridge, Tempo search and local port quirks (Phase 1) |
| [web-demo-storefront.md](web-demo-storefront.md) | How examples/web is wired to the demo backend and the browser SDK, stub mode, backend JSON quirks, React dev double-reporting of uncaught errors (Phase 2) |
| [e2e-scenario.md](e2e-scenario.md) | How the Phase 6 scenario generates synthetic web/mobile sessions via OTLP/JSON and asserts rum-api and Grafana; Tempo/Grafana API quirks; forcing a fresh browser session (Phase 6) |
| [ios-replay.md](ios-replay.md) | How the iOS replay capture works (screenshot + view-walk masking, dedupe, chunks, gzip, upload), the Expo module/CocoaPods vendoring layout, RN text view classes, and what was verified without Xcode (Phase 7) |
| [xcode-setup.md](xcode-setup.md) | Exact steps to install Xcode, the iOS platform and CocoaPods on this Mac, build the dev client and run the manual replay check list (Phase 7) |
