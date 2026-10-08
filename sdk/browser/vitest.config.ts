import { defineConfig } from "vitest/config";

export default defineConfig({
  // The OTel packages pick their platform build through the legacy package.json `browser`
  // field. Inline them so Vite resolves that field; otherwise Node loads the node build,
  // whose OTLP exporters use node:http instead of fetch.
  resolve: {
    mainFields: ["browser", "module", "main"],
    conditions: ["browser", "import", "module", "default"],
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    server: {
      deps: {
        inline: [/@opentelemetry\//, /rrweb/, /web-vitals/],
      },
    },
  },
});
