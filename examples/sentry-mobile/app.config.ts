import type { ExpoConfig } from "expo/config";

/**
 * sentry-demo: an Expo app instrumented ONLY with @sentry/react-native, used to generate real Sentry
 * SDK traffic (sentry-cocoa + RN JS layer, mobile Session Replay) for the ouo Sentry bridge
 * (ADR-0008, docs/specs/sentry-bridge.md). No ouo SDK here.
 *
 * Build-time environment:
 *   SENTRY_DSN   DSN the SDK sends to. Default points at a local recorder / ouosentry receiver on
 *                localhost:4400. Never point it at sentry.io from this repo.
 *   BACKEND_URL  demo backend (examples/backend). Default: the main compose stack on :8082.
 *   APP_VERSION  release version, BUILD_NUMBER the build: release = sentry-demo@<version>+<build>.
 *   SENTRY_DEBUG=1 turns on the SDK debug logger (JS and native).
 *   OUO_SDK=1    parallel mode: @ouo/react-native runs next to Sentry (initialised after it, see
 *                index.ts and src/ouo.ts), exporting to OUO_OTLP_ENDPOINT and OUO_REPLAY_ENDPOINT
 *                (default the isolated ouo-sb collector: 4338 and 4339).
 *   OUO_REPLAY=0 parallel mode without the ouo replay (default on).
 * Values are baked into the JS bundle (Release build), so rebuild after changing them.
 */
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
    ouoSdk: process.env.OUO_SDK === "1",
    ouoReplay: process.env.OUO_REPLAY !== "0",
    ouoOtlpEndpoint: process.env.OUO_OTLP_ENDPOINT ?? "http://localhost:4338",
    ouoReplayEndpoint: process.env.OUO_REPLAY_ENDPOINT ?? "http://localhost:4339",
    ouoProjectId: process.env.OUO_PROJECT_ID ?? "demo",
    ouoProjectToken: process.env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
  },
};

export default config;
