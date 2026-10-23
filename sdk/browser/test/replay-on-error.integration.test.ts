/** Error-triggered replay: nothing is uploaded until the first error, then the buffer and the rest. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { initRUM, type RUM } from "../src/index";
import { stubFetch, wait } from "./helpers/otlp";

const BASE = "http://localhost:8094";
const { captured } = stubFetch(BASE);
let rum: RUM & { _uninstall?: () => Promise<void> };

const chunks = () =>
  captured
    .filter((c) => c.url === `${BASE}/v1/replay/chunks`)
    .map((c) => {
      const raw = c.raw as ArrayBuffer | string;
      const text = typeof raw === "string" ? raw : gunzipSync(new Uint8Array(raw)).toString();
      return JSON.parse(text) as { seq: number; events: Array<{ type: number }> };
    });

beforeAll(() => {
  localStorage.clear();
  rum = initRUM({
    endpoint: BASE,
    projectId: "web-store",
    projectToken: "pt_test_onerror",
    service: { name: "web-store", version: "1.0.0", environment: "test" },
    replay: { enabled: true, sampleRate: 0, onErrorSampleRate: 1, flushIntervalMs: 100 },
  });
});

afterAll(async () => {
  await rum._uninstall?.();
});

describe("error-triggered replay end to end", () => {
  it("buffers, then uploads the buffer starting with a full snapshot after captureError", async () => {
    await vi.waitFor(() => expect(rum.replay.isRecording()).toBe(true), { timeout: 5000 }); // rrweb is a lazy chunk
    document.body.appendChild(document.createElement("p")).textContent = "before the error";
    await wait(300);
    await rum.flush();
    expect(rum.replay.isRecording()).toBe(true);
    expect(captured.some((c) => c.url === `${BASE}/v1/replay/chunks`)).toBe(false);

    rum.captureError(new Error("checkout failed"));
    await vi.waitFor(
      async () => {
        await rum.flush();
        expect(chunks().length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 200 },
    );
    const got = chunks();
    expect(got.length).toBeGreaterThan(0);
    const types = got.flatMap((c) => c.events.map((e) => e.type));
    expect(types[0]).toBe(4); // Meta, then FullSnapshot: the buffer starts at a checkout
    expect(types[1]).toBe(2);
    expect(types.filter((t) => t === 2).length).toBeGreaterThanOrEqual(2); // buffer + fresh full-mode snapshot
    expect(JSON.parse(localStorage.getItem("ouo.session")!).replayTriggered).toBe(true);
  });
});
