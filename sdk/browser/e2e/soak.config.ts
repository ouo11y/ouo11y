import { defineConfig, devices } from "@playwright/test";

/**
 * Long-running checks of the built SDK, never part of the per-PR suite: the soak
 * (e2e/soak.spec.ts, OUO_SOAK_MINUTES, default 2) and the rrweb cost measurement
 * (e2e/rrweb-cost.spec.ts). `npm run test:soak`, or the "browser soak" workflow
 * (.github/workflows/browser-soak.yml). OUO_SOAK_PROJECTS picks engines (default chromium,webkit).
 */
const wanted = (process.env.OUO_SOAK_PROJECTS ?? "chromium,webkit").split(",");
const all = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
];

// Separate ports let two engines soak at the same time (two runs, each with its own stub).
const pagePort = Number(process.env.OUO_E2E_PAGE_PORT ?? 4180);

export default defineConfig({
  testDir: ".",
  testMatch: /(soak|rrweb-cost)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 0,
  reporter: "list",
  use: { baseURL: `http://localhost:${pagePort}` },
  webServer: {
    command: "node e2e/server.mjs",
    cwd: "..",
    url: `http://localhost:${pagePort}/`,
    reuseExistingServer: !process.env.CI,
  },
  projects: all.filter((p) => wanted.includes(p.name)),
});
