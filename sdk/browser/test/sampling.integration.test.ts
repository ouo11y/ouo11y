/** An unsampled session (sessionSampleRate 0) sends nothing and propagates sampled=0. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initRUM, type RUM } from "../src/index";
import { stubFetch, wait } from "./helpers/otlp";

const BASE = "http://localhost:8093";
const API = "http://localhost:8084";
const { captured } = stubFetch(BASE);
let rum: RUM & { _uninstall?: () => Promise<void> };

beforeAll(() => {
  localStorage.clear();
  rum = initRUM({
    endpoint: BASE,
    projectId: "web-store",
    projectToken: "pt_test_sampling",
    service: { name: "web-store", version: "1.0.0", environment: "test" },
    tracing: { propagateTo: [new RegExp(`^${API}`)] },
    sampling: { sessionSampleRate: 0 },
    replay: { enabled: true, flushIntervalMs: 100 },
  });
});

afterAll(async () => {
  await rum._uninstall?.();
});

describe("session sampling end to end", () => {
  it("exports no span, event or replay chunk, and sends traceparent with the sampled flag off", async () => {
    await fetch(`${API}/api/products`);
    rum.addEvent("cart.added", { sku: "x" });
    rum.captureError(new Error("boom"));
    await wait(600);
    await rum.flush();
    expect(captured.filter((c) => c.url.startsWith(BASE))).toHaveLength(0);
    const req = captured.find((c) => c.url === `${API}/api/products`)!;
    expect(req.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(rum.replay.isRecording()).toBe(false);
    expect(JSON.parse(localStorage.getItem("ouo.session")!).sampled).toBe(false);
  });
});
