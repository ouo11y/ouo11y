import { defineConfig, devices } from "@playwright/test";

// Long sessions (GR-MEM-1 to GR-MEM-3): by hand or from the browser-soak workflow, never per PR.
//   OUO_SOAK_MINUTES=60 OUO_SOAK_PROJECTS=chromium,firefox npm run test:soak
const PAGE_PORT = Number(process.env.OUO_E2E_PAGE_PORT ?? 4180);
process.env.OUO_E2E_COLLECTOR_PORT ??= String(PAGE_PORT + 1);
const minutes = Number(process.env.OUO_SOAK_MINUTES ?? 1);
const wanted = (process.env.OUO_SOAK_PROJECTS ?? "chromium").split(",").map((s) => s.trim());
const all = { chromium: devices["Desktop Chrome"], firefox: devices["Desktop Firefox"], webkit: devices["Desktop Safari"] };

export default defineConfig({
  testDir: ".",
  testMatch: /soak\.spec\.ts/,
  workers: 1,
  timeout: (minutes + 3) * 60_000,
  reporter: "list",
  use: { baseURL: `http://localhost:${PAGE_PORT}` },
  webServer: { command: "node e2e/server.mjs", cwd: "..", url: `http://localhost:${PAGE_PORT}/`, reuseExistingServer: !process.env.CI },
  projects: Object.entries(all).filter(([name]) => wanted.includes(name)).map(([name, use]) => ({ name, use: { ...use } })),
});
