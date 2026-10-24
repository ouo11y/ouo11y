/**
 * The session lifecycle through the public API, asserted on the OTLP log records: user change,
 * logout, endSession, and `device.id` on the resource and the session records.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initRUM, type RUM } from "../src/index";
import { stubFetch } from "./helpers/otlp";

const BASE = "http://localhost:8096";
const { captured, logRecords } = stubFetch(BASE);
let rum: RUM;

beforeAll(() => {
  localStorage.clear();
  rum = initRUM({
    endpoint: BASE,
    projectId: "web-store",
    projectToken: "pt_test_session_api",
    service: { name: "web-store", version: "1.0.0", environment: "test" },
    tracing: { documentLoad: false },
    replay: { enabled: false },
  });
});

afterAll(async () => {
  await rum.shutdown();
});

describe("session lifecycle API", () => {
  it("login keeps the session, a user switch and a logout rotate it, endSession ends it", async () => {
    const device = rum.session.deviceId();
    const first = rum.session.id();
    rum.setUser({ id: "u-1" });
    expect(rum.session.id()).toBe(first);
    rum.setUser({ id: "u-2" });
    const second = rum.session.id();
    expect(second).not.toBe(first);
    rum.clearUser();
    const third = rum.session.id();
    expect(third).not.toBe(second);
    rum.endSession();
    rum.addEvent("after.end");
    await rum.flush();

    const session = logRecords().filter((r) => r.eventName === "session.start" || r.eventName === "session.end");
    expect(session.map((r) => `${r.eventName}:${r.attributes["ouo.session.end_reason"] ?? ""}:${r.attributes["user.id"] === "u-1" ? "u-1" : r.attributes["user.id"] === "u-2" ? "u-2" : "anon"}`)).toEqual([
      "session.start::anon",
      "session.end:user_change:u-1",
      "session.start::u-2",
      "session.end:user_change:u-2",
      "session.start::anon",
      "session.end:manual:anon",
      "session.start::anon",
    ]);
    expect(session.every((r) => r.attributes["device.id"] === device)).toBe(true);
    const after = logRecords().find((r) => r.eventName === "after.end")!;
    expect(after.attributes["session.previous_id"]).toBe(third);

    // device.id is a resource attribute of every export.
    const resources = captured
      .filter((c) => c.url === `${BASE}/v1/logs`)
      .flatMap((c) => (c.body as { resourceLogs: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> } }> }).resourceLogs);
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) expect(r.resource.attributes.find((a) => a.key === "device.id")?.value.stringValue).toBe(device);
  });
});
