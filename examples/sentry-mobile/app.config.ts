import type { ExpoConfig } from "expo/config";

/**
 * sentry-demo: an Expo app instrumented ONLY with @sentry/react-native, used to generate real Sentry
 * SDK traffic (sentry-cocoa + RN JS layer, mobile Session Replay) for the ouo Sentry bridge
 * (ADR-0008, docs/specs/sentry-bridge.md), and to show the runtime rollout from Sentry to ouo.
 *
 * Build-time environment:
 *   SENTRY_DSN   DSN the SDK sends to. Default points at a local recorder / ouosentry receiver on
 *                localhost:4400. Never point it at sentry.io from this repo.
 *   BACKEND_URL  demo backend (examples/backend). Default: the main compose stack on :8082.
 *   APP_VERSION  release version, BUILD_NUMBER the build: release = sentry-demo@<version>+<build>.
 *   SENTRY_DEBUG=1 turns on the SDK debug logger (JS and native).
 *   Rollout (ROLLOUT.md, src/rollout.ts): the OpenFeature flag `ouo.rum.mode` picks, per device and
 *   per cold start, `sentry` (Sentry through the bridge DSN SENTRY_DSN), `parallel` (Sentry straight
 *   to SENTRY_DIRECT_DSN + ouo, ouo replay off) or `ouo` (ouo only).
 *     OUO_FLAG_PROVIDER  `ofrep` (default; flagd's OFREP API at OUO_FLAG_URL, default :8016) or
 *                        `memory` (no server; the variant is OUO_RUM_MODE).
 *     OUO_FLAG_TIMEOUT_MS  first-launch wait for the flag (default 1500), then OUO_DEFAULT_MODE
 *                        (default `sentry`).
 *   ouo exports to OUO_OTLP_ENDPOINT and OUO_REPLAY_ENDPOINT (default the isolated ouo-sb
 *   collector: 4338 and 4339).
 *   OUO_PERF=1   overhead measurement build (scripts/perf): a JS frame monitor writes
 *                Documents/perf.json, and Documents/perf-mode.json overrides the rollout mode per
 *                launch (the flag is then not evaluated).
 * Values are baked into the JS bundle (Release build), so rebuild after changing them.
 */
const modes = ["sentry", "parallel", "ouo"];
const mode = (v: string | undefined, fallback: string): string => {
  if (v === undefined || v === "") return fallback;
  if (!modes.includes(v)) throw new Error(`rum mode must be one of ${modes.join(", ")}, got ${v}`);
  return v;
};
if (process.env.OUO_SDK) throw new Error("OUO_SDK was replaced by the runtime rollout: see ROLLOUT.md (OUO_FLAG_PROVIDER=memory OUO_RUM_MODE=parallel)");
// ouo replay follows the mode (off in `parallel`, on in `ouo`); the perf harness can force it per launch.
if (process.env.OUO_REPLAY) throw new Error("OUO_REPLAY was replaced by the runtime rollout: `parallel` has ouo replay off, `ouo` on (ROLLOUT.md); scripts/perf sets it per launch");

const version = process.env.APP_VERSION ?? "1.0.0";
const buildNumber = process.env.BUILD_NUMBER ?? "1";

const config: ExpoConfig = {
  name: "sentry-demo",
  slug: "sentry-demo",
  scheme: "sentrydemo",
  version,
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: false,
    bundleIdentifier: "dev.ouo.sentrydemo",
    buildNumber,
    infoPlist: {
      // Demo only: plain http to the local backend and the local DSN host.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true },
    },
  },
  web: { favicon: "./assets/favicon.png" },
  plugins: [
    // iOS 27 requires the UIScene life cycle; Expo 57's template does not add it yet (kb/xcode-setup.md).
    "./plugins/withUIScene.js",
    // disableAutoUpload: the build phases must never call sentry-cli / sentry.io.
    ["@sentry/react-native", { disableAutoUpload: true }],
  ],
  extra: {
    sentryDsn: process.env.SENTRY_DSN ?? "http://publickey0000000000000000000000@localhost:4400/1",
    release: `sentry-demo@${version}+${buildNumber}`,
    dist: buildNumber,
    environment: process.env.SENTRY_ENVIRONMENT ?? "development",
    backendUrl: process.env.BACKEND_URL ?? "http://localhost:8082",
    sentryDebug: process.env.SENTRY_DEBUG === "1",
    sentryDirectDsn: process.env.SENTRY_DIRECT_DSN ?? "http://publickey0000000000000000000000@localhost:4401/1",
    defaultMode: mode(process.env.OUO_DEFAULT_MODE, "sentry"),
    flagProvider: process.env.OUO_FLAG_PROVIDER === "memory" ? "memory" : "ofrep",
    flagUrl: process.env.OUO_FLAG_URL ?? "http://localhost:8016",
    flagTimeoutMs: Number(process.env.OUO_FLAG_TIMEOUT_MS ?? 1500),
    flagMemoryMode: mode(process.env.OUO_RUM_MODE, "sentry"),
    ouoOtlpEndpoint: process.env.OUO_OTLP_ENDPOINT ?? "http://localhost:4338",
    ouoReplayEndpoint: process.env.OUO_REPLAY_ENDPOINT ?? "http://localhost:4339",
    ouoProjectId: process.env.OUO_PROJECT_ID ?? "demo",
    ouoProjectToken: process.env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
    perfModes: process.env.OUO_PERF === "1",
  },
};

export default config;
