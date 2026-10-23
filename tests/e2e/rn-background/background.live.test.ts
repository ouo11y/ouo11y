import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { initRUM, type RUMInternal } from "../../../sdk/react-native/src/index";
import { MemoryAsyncStorage } from "../../../sdk/react-native/src/session/storage";
import { AppState } from "../../../sdk/react-native/test/mocks/react-native";

// Same variables as tests/e2e/scenario.mjs (deploy/envs/ouo-env env <env> exports them).
const env = process.env;
const OTLP = (env.OUO_OTLP_URL ?? "http://localhost:4318").replace(/\/$/, "");
const RUM_API = (env.OUO_RUM_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const PROJECT_ID = env.OUO_PROJECT_ID ?? "demo";
const PROJECT_TOKEN = env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000";
const READ_TOKEN = env.OUO_READ_TOKEN ?? "rt_dev_0000000000000000";
const BACKGROUND_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function session(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${RUM_API}/v1/sessions/${id}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  return { status: res.status, body: res.ok ? ((await res.json()) as Record<string, unknown>) : {} };
}

it("a background stay longer than backgroundTimeoutMs ends the session with end_reason background in rum-api", async () => {
  const service = `qa-rn-background-${Date.now().toString(36)}`;
  (globalThis as { ErrorUtils?: unknown }).ErrorUtils = { getGlobalHandler: () => () => {}, setGlobalHandler: () => {} };
  AppState.__emit("active");
  const rum = initRUM({
    endpoint: OTLP,
    projectId: PROJECT_ID,
    projectToken: PROJECT_TOKEN,
    service: { name: service, version: "1.0.0", environment: "qa" },
    session: { backgroundTimeoutMs: BACKGROUND_MS },
    storage: new MemoryAsyncStorage(),
    device: { modelIdentifier: "iPhone17,2", manufacturer: "Apple" },
  }) as RUMInternal;
  await rum.ready;
  const first = rum.session.id();
  rum.trackNavigation("/home");
  AppState.__emit("background");
  await sleep(BACKGROUND_MS + 1000);
  AppState.__emit("active");
  rum.trackNavigation("/home");
  const second = rum.session.id();
  expect(second).not.toBe(first);
  expect(rum.session.previousId()).toBe(first);
  await rum.flush();
  await rum._uninstall();

  // rum-api folds the session from Loki: wait for the session.end record.
  let got = { status: 0, body: {} as Record<string, unknown> };
  for (let i = 0; i < 60; i++) {
    got = await session(first);
    if (got.status === 200 && got.body.end_reason) break;
    await sleep(2000);
  }
  // tests/e2e/edge-qa.mjs reads this back into its result file (OUO_QA_BACKGROUND_OUT).
  if (env.OUO_QA_BACKGROUND_OUT) {
    const { end_reason, state, status, ended_at } = got.body;
    writeFileSync(env.OUO_QA_BACKGROUND_OUT, JSON.stringify({ service, first, second, http: got.status, end_reason, state, status, ended_at }));
  }
  expect(got.status).toBe(200);
  expect(got.body.end_reason).toBe("background");
  expect(got.body.state).toBe("ended");
  expect(got.body.status).toBe("healthy");
});
