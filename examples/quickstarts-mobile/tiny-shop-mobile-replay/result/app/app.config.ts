// Tiny Shop Mobile: the Expo app config (it replaces app.json so it can read the environment).
// The app's own settings (API URL, Sentry DSN, replay sampling and masking) are EXPO_PUBLIC_*
// variables read in src/config.ts.
import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Tiny Shop",
  slug: "tiny-shop-mobile-replay",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: false,
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? "dev.ouo.tinyshop",
    // Plain http to the API and the Sentry bridge on this Mac (local development only).
    infoPlist: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } },
  },
  plugins: [
    // iOS 27 refuses to launch an app without the UIScene life cycle; Expo 57's template lacks it.
    "./plugins/withUIScene.js",
    // disableAutoUpload: the build never calls sentry-cli or sentry.io (no Sentry account here).
    ["@sentry/react-native", { disableAutoUpload: true }],
  ],
};

export default config;
