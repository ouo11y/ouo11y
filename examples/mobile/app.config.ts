import type { ExpoConfig } from "expo/config";

/**
 * APP_VERSION switches `service.version` so the health split by version has data:
 *   APP_VERSION=2.4.0 npx expo start --ios
 * BACKEND_URL / OTLP_ENDPOINT default to the alternate host ports of deploy/docker/.env.
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
  extra: {
    backendUrl: process.env.BACKEND_URL ?? "http://localhost:8082",
    otlpEndpoint: process.env.OTLP_ENDPOINT ?? "http://localhost:4328",
    environment: process.env.OUO_ENV ?? "local",
  },
};

export default config;
