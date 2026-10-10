import type { ExpoConfig } from "expo/config";

/**
 * APP_VERSION switches `service.version` so the health split by version has data:
 *   APP_VERSION=2.4.0 npx expo start --ios
 * EXPO_PUBLIC_RUM_API is the rum-api base URL (ADR-0007: the SDK talks only to rum-api, which
 * forwards OTLP to the collector), EXPO_PUBLIC_OUO_PROJECT_TOKEN the project token; both default
 * to the stock compose stack and its development token. BACKEND_URL is the demo backend.
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
    rumApi: process.env.EXPO_PUBLIC_RUM_API ?? "http://localhost:8080",
    projectToken: process.env.EXPO_PUBLIC_OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
    environment: process.env.OUO_ENV ?? "local",
  },
};

export default config;
