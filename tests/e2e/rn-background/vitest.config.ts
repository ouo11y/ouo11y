// Live run of the React Native SDK's `background` session end (checklist N15): the SDK's
// own code (sdk/react-native/src) with the same react-native / AsyncStorage / Expo stand-ins
// as its unit tests, exporting to a real collector and checked in rum-api. Only the OS
// AppState transition is simulated. Run through deploy/scripts/qa-edge.sh (needs an env).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sdk = (p: string): string => fileURLToPath(new URL(`../../../sdk/react-native/${p}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    mainFields: ["browser", "module", "main"],
    conditions: ["browser", "import", "module", "default"],
    alias: {
      "react-native": sdk("test/mocks/react-native.ts"),
      "@react-native-async-storage/async-storage": sdk("test/mocks/async-storage.ts"),
      "expo-modules-core": sdk("test/mocks/expo-modules-core.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["*.live.test.ts"],
    testTimeout: 180_000,
    server: { deps: { inline: [/@opentelemetry\//] } },
  },
});
