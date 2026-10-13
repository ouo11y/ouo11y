import type { ExpoConfig } from "expo/config";

/**
 * APP_VERSION switches `service.version` so the health split by version has data:
 *   APP_VERSION=2.4.0 npx expo start --ios
 * EXPO_PUBLIC_OTLP_ENDPOINT is the collector's OTLP/HTTP base URL (ADR-0007: the collector is the
 * only edge; the SDK derives the replay receiver on port 4319 from port 4318), EXPO_PUBLIC_OUO_PROJECT_ID
 * and EXPO_PUBLIC_OUO_PROJECT_TOKEN the project credential (sent as HTTP Basic); all three default to
 * the stock compose stack and its development project. BACKEND_URL is the demo backend.
 * From the iOS Simulator `localhost` reaches the Mac; a physical device needs the Mac's LAN IP.
 */
const config: ExpoConfig = {
  name: "mobile-store",
  slug: "mobile-store",
  version: process.env.APP_VERSION ?? "2.3.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "dev.ouo.mobilestore",
  },
  android: {
    package: "dev.ouo.mobilestore",
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
  },
  web: { favicon: "./assets/favicon.png" },
  // iOS 27 requires the UIScene life cycle; Expo 57's template does not add it yet.
  plugins: ["./plugins/withUIScene.js"],
  extra: {
    backendUrl: process.env.BACKEND_URL ?? "http://localhost:8081",
    otlpEndpoint: process.env.EXPO_PUBLIC_OTLP_ENDPOINT ?? "http://localhost:4318",
    projectId: process.env.EXPO_PUBLIC_OUO_PROJECT_ID ?? "demo",
    projectToken: process.env.EXPO_PUBLIC_OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
    environment: process.env.OUO_ENV ?? "local",
  },
};

export default config;
