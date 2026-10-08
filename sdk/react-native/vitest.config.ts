import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const mock = (name: string): string => fileURLToPath(new URL(`./test/mocks/${name}.ts`, import.meta.url));

export default defineConfig({
  // Same trick as sdk/browser: resolve the OTel packages' `browser` field so the tests
  // exercise the fetch transport and the browser id generator that run on Hermes. This
  // only works with a "web" transform mode, hence the jsdom environment: with
  // environment "node" Vite's SSR resolver ignores the browser field and the tests get
  // the node:http exporter.
  resolve: {
    mainFields: ["browser", "module", "main"],
    conditions: ["browser", "import", "module", "default"],
    alias: {
      "react-native": mock("react-native"),
      "@react-native-async-storage/async-storage": mock("async-storage"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    server: {
      deps: {
        inline: [/@opentelemetry\//],
      },
    },
  },
});
