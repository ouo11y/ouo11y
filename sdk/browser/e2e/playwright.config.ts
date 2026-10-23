import { defineConfig, devices } from "@playwright/test";

/**
 * Cross-browser end-to-end tests of the built SDK (`npm run build` first): Chromium, Firefox
 * and WebKit against e2e/server.mjs (test pages + collector stub). `npm run test:e2e`.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: "http://localhost:4180" },
  webServer: {
    command: "node e2e/server.mjs",
    cwd: "..",
    url: "http://localhost:4180/",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
