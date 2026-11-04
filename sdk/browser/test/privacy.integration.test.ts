/**
 * Replay privacy end to end (ADR-0003 revision 2026-11-03): `initRUM` with the defaults masks
 * all text, `ouo-unmask` text is recorded, and a soft navigation to a never-record route stops
 * the recording before the route's DOM reaches a chunk, with an `ouo.replay.hidden` marker in
 * the replay and on the timeline; leaving the route records again from a full snapshot.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initRUM, type RUM } from "../src/index";
import { bodyText, stubFetch } from "./helpers/otlp";

const BASE = "http://localhost:8095";
const { captured, logRecords } = stubFetch(BASE);
let rum: RUM & { _uninstall?: () => Promise<void> };

const events = () =>
  captured
    .filter((c) => c.url === `${BASE}/v1/replay/chunks`)
    .flatMap((c) => (JSON.parse(bodyText(c.raw)) as { events: Array<{ type: number; data?: { tag?: string; payload?: unknown } }> }).events);

const replayText = (): string => JSON.stringify(events());

async function flushed(): Promise<void> {
  await rum.flush();
  await new Promise((r) => setTimeout(r, 50));
  await rum.flush();
}

beforeAll(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  document.body.innerHTML = '<h1>Jane Doe</h1><nav class="ouo-unmask"><a href="/agenda">Agenda</a></nav>';
  rum = initRUM({
    endpoint: BASE,
    projectId: "care",
    projectToken: "pt_test_privacy",
    service: { name: "care-portal", version: "1.0.0", environment: "test" },
    replay: { flushIntervalMs: 100, excludeRoutes: ["/patients/*"] },
  });
});

afterAll(async () => {
  await rum._uninstall?.();
  history.replaceState(null, "", "/");
});

describe("replay privacy end to end", () => {
  it("masks text by default and records ouo-unmask text", async () => {
    await vi.waitFor(() => expect(rum.replay.isRecording()).toBe(true), { timeout: 5000 });
    await vi.waitFor(async () => {
      await flushed();
      expect(events().some((e) => e.type === 2)).toBe(true);
    });
    const text = replayText();
    expect(text).not.toContain("Jane");
    expect(text).toContain("**** ***");
    expect(text).toContain("Agenda");
  });

  it("a soft navigation to an excluded route records none of its DOM and marks the replay and the timeline", async () => {
    const before = events().length;
    // A router that commits the new page and updates the URL in one task.
    document.body.innerHTML = '<div class="ouo-unmask"><h1>Diagnosis: secret</h1></div>';
    history.pushState(null, "", "/patients/42");
    expect(rum.replay.isRecording()).toBe(false);
    document.body.appendChild(document.createElement("p")).textContent = "added while hidden";
    await flushed();
    const after = events().slice(before);
    expect(after.filter((e) => e.type === 5 && e.data?.tag === "ouo.replay.hidden")).toEqual([
      expect.objectContaining({ data: { tag: "ouo.replay.hidden", payload: { reason: "route" } } }),
    ]);
    expect(replayText()).not.toContain("Diagnosis");
    expect(replayText()).not.toContain("added while hidden");
    expect(after.some((e) => e.type === 3)).toBe(false);
    const hidden = logRecords().filter((r) => r.eventName === "ouo.replay.hidden");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.attributes["ouo.replay.hidden_reason"]).toBe("route");
  });

  it("leaving the route records again from a full snapshot of the next page, not the hidden one", async () => {
    const before = events().length;
    // React Router's order: the URL changes first, the next page renders after it.
    history.pushState(null, "", "/home");
    expect(rum.replay.isRecording()).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    document.body.innerHTML = '<p class="ouo-unmask">Back home</p>';
    await vi.waitFor(() => expect(rum.replay.isRecording()).toBe(true));
    await vi.waitFor(async () => {
      await flushed();
      expect(events().slice(before).some((e) => e.type === 2)).toBe(true);
    });
    expect(replayText()).toContain("Back home");
    expect(replayText()).not.toContain("Diagnosis");
  });
});
