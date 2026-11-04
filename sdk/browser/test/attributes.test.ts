/**
 * User and session attributes (docs/specs/attributes.md): validation, the `ouo.attr.*` stamp on
 * spans and events, the user set's rotation rule, persistence with the user, removal.
 */
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeAttributes, signalAttributes } from "../src/attributes";
import { initRUM, type RUM } from "../src/index";
import { stubFetch } from "./helpers/otlp";

describe("mergeAttributes", () => {
  it("keeps valid keys and primitive values, cuts long strings, drops the rest", () => {
    const warn = vi.fn();
    const out = mergeAttributes(
      {},
      {
        tenant: "acme",
        plan_tier: 3,
        beta: false,
        long: "x".repeat(300),
        "has.dot": "a",
        "has-dash": "a",
        _leading: "a",
        "9lives": "a",
        ["k" + "x".repeat(40)]: "too long key",
        nul: null,
        obj: { a: 1 },
        arr: [1],
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        undef: undefined,
      },
      {},
      warn,
    );
    expect(out).toEqual({ tenant: "acme", plan_tier: 3, beta: false, long: "x".repeat(128) });
    expect(warn).toHaveBeenCalledTimes(11);
  });

  it("caps distinct keys across both sets at 20 and still updates existing keys", () => {
    const other: Record<string, string> = {};
    for (let i = 0; i < 5; i++) other[`u${i}`] = "u";
    const into: Record<string, string> = {};
    for (let i = 0; i < 15; i++) into[`a${i}`] = "a";
    const warn = vi.fn();
    mergeAttributes(into, { a0: "changed", u0: "shadow", extra: "dropped" }, other, warn);
    expect(into.a0).toBe("changed");
    expect(into.u0).toBe("shadow");
    expect(into.extra).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("attribute dropped", "extra", "over 20 keys");
  });

  it("is safe with prototype names and ignores non-objects", () => {
    const out = mergeAttributes({}, { constructor: "c", toString: "t" }, {}, () => undefined);
    expect(out).toEqual({ constructor: "c", toString: "t" });
    expect(mergeAttributes({}, "nope", {}, () => undefined)).toEqual({});
    expect(mergeAttributes({}, null, {}, () => undefined)).toEqual({});
  });

  it("prefixes signal keys and lets the app set win", () => {
    expect(signalAttributes({ tenant: "user", plan: "free" }, { tenant: "app" })).toEqual({ "ouo.attr.tenant": "app", "ouo.attr.plan": "free" });
  });
});

describe("rum.setAttributes / setUser({ attributes }) / removeAttribute", () => {
  const BASE = "http://localhost:8097";
  const { logRecords, spans } = stubFetch(BASE);
  let rum: RUM | undefined;

  afterEach(async () => {
    await rum?.shutdown();
    rum = undefined;
  });

  const start = (user?: { id: string; attributes?: Record<string, string | number | boolean> }): RUM => {
    rum = initRUM({
      endpoint: BASE,
      projectId: "web-store",
      projectToken: "pt_test_attributes",
      service: { name: "web-store", version: "1.0.0", environment: "test" },
      tracing: { documentLoad: false },
      replay: { enabled: false },
      ...(user ? { user } : {}),
    });
    return rum;
  };

  it("stamps every later span and event, never earlier ones", async () => {
    localStorage.clear();
    const r = start();
    r.addEvent("before");
    r.setAttributes({ tenant: "acme", seats: 12 });
    r.addEvent("after", { "ouo.attr.tenant": "own value wins" });
    r.addEvent("after2");
    trace.getTracer("t").startSpan("work").end();
    await r.flush();
    const byName = (n: string) => logRecords().find((x) => x.eventName === n)!;
    expect(byName("before").attributes["ouo.attr.tenant"]).toBeUndefined();
    expect(byName("after").attributes["ouo.attr.tenant"]).toBe("own value wins");
    expect(byName("after").attributes["ouo.attr.seats"]).toBe(12);
    expect(byName("after2").attributes["ouo.attr.tenant"]).toBe("acme");
    const span = spans().find((s) => s.name === "work")!;
    expect(span.attributes["ouo.attr.tenant"]).toBe("acme");
    expect(span.attributes["ouo.attr.seats"]).toBe(12);
  });

  it("swaps the user set at the user_change rotation and persists it with the user", async () => {
    localStorage.clear();
    const r = start();
    r.setAttributes({ app_flag: true });
    r.setUser({ id: "u-1", attributes: { plan: "pro" } });
    r.addEvent("as.u1");
    r.setUser({ id: "u-2", attributes: { plan: "free", tenant: "beta" } });
    r.addEvent("as.u2");
    r.setUser({ id: "u-2" }); // same user, no attributes: the set stays
    r.addEvent("as.u2.again");
    r.clearUser();
    r.addEvent("anon");
    await r.flush();

    const recs = logRecords();
    const at = (n: string) => recs.find((x) => x.eventName === n)!.attributes;
    expect(at("as.u1")["ouo.attr.plan"]).toBe("pro");
    expect(at("as.u1")["ouo.attr.app_flag"]).toBe(true);
    expect(at("as.u2")["ouo.attr.plan"]).toBe("free");
    expect(at("as.u2.again")["ouo.attr.tenant"]).toBe("beta");
    expect(at("anon")["ouo.attr.plan"]).toBeUndefined();
    expect(at("anon")["ouo.attr.app_flag"]).toBe(true);

    const rotation = recs.filter((x) => x.eventName === "session.end" || x.eventName === "session.start");
    const end1 = rotation.find((x) => x.eventName === "session.end" && x.attributes["user.id"] === "u-1")!;
    expect(end1.attributes["ouo.attr.plan"]).toBe("pro");
    const start2 = rotation.find((x) => x.eventName === "session.start" && x.attributes["user.id"] === "u-2")!;
    expect(start2.attributes["ouo.attr.plan"]).toBe("free");
    const end2 = rotation.find((x) => x.eventName === "session.end" && x.attributes["user.id"] === "u-2")!;
    expect(end2.attributes["ouo.attr.tenant"]).toBe("beta");
  });

  it("keeps the user set across a reload; options.user.attributes replace it", async () => {
    localStorage.clear();
    let r = start();
    r.setUser({ id: "u-9", attributes: { plan: "pro" } });
    await r.shutdown();
    expect(JSON.parse(localStorage.getItem("ouo.user")!)).toEqual({ id: "u-9", anonymous: false, attrs: { plan: "pro" } });

    r = start({ id: "u-9" });
    r.addEvent("reloaded");
    await r.shutdown();
    r = start({ id: "u-9", attributes: { plan: "enterprise" } });
    r.addEvent("reloaded.with.options");
    await r.flush();
    const at = (n: string) => logRecords().find((x) => x.eventName === n)!.attributes;
    expect(at("reloaded")["ouo.attr.plan"]).toBe("pro");
    expect(at("reloaded.with.options")["ouo.attr.plan"]).toBe("enterprise");
  });

  it("removeAttribute removes from both sets; invalid calls never throw", async () => {
    localStorage.clear();
    const r = start({ id: "u-3", attributes: { plan: "pro", tenant: "acme" } });
    r.setAttributes({ cohort: "b" });
    r.removeAttribute("plan");
    r.removeAttribute("cohort");
    r.removeAttribute("absent");
    expect(() => r.setAttributes(null as never)).not.toThrow();
    expect(() => r.setAttributes({ bad: {} } as never)).not.toThrow();
    r.addEvent("after.remove");
    await r.flush();
    const at = logRecords().find((x) => x.eventName === "after.remove")!.attributes;
    expect(at["ouo.attr.plan"]).toBeUndefined();
    expect(at["ouo.attr.cohort"]).toBeUndefined();
    expect(at["ouo.attr.tenant"]).toBe("acme");
    expect(at["user.id"]).toBe("u-3");
    expect(r.session.userId()).toBe("u-3");
  });
});
