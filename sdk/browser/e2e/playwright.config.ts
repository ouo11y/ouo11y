import { defineConfig, devices } from "@playwright/test";

// OUO_E2E_PAGE_PORT moves the page server (the collector stub is on the next port) so parallel checkouts do not share one.
const PAGE_PORT = Number(process.env.OUO_E2E_PAGE_PORT ?? 4180);
process.env.OUO_E2E_COLLECTOR_PORT ??= String(PAGE_PORT + 1);

/**
 * Cross-browser end-to-end tests of the built SDK (`npm run build` first): Chromium, Firefox
 * and WebKit against e2e/server.mjs (test pages + collector stub). `npm run test:e2e`.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  // Long-running: soak.config.ts, run nightly or by hand.
  testIgnore: /(soak|rrweb-cost)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: `http://localhost:${PAGE_PORT}` },
  webServer: {
    command: "node e2e/server.mjs",
    cwd: "..",
    url: `http://localhost:${PAGE_PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
