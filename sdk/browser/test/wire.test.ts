/**
 * Wire tests: drive the SDK in jsdom and assert on the OTLP the fake Collector received
 * (SDK spec section 14, method W). The rules of section 6.1 are checked on every record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ouo from "../src/index";
import { FakeCollector, until, wait, type CapturedLog } from "./helpers/collector";

const BASE = "http://collector.test:4318";
const collector = new FakeCollector(BASE);
const TOKEN = "pt_canary_4f9a1c7e";
const base: ouo.OuoConfig = {
  endpoint: BASE,
  projectId: "web-store",
  projectToken: TOKEN,
  serviceName: "web-store",
  serviceVersion: "1.2.3",
  environment: "test",
  transport: { flushIntervalMs: 250 },
};

const SCHEMA = "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev";

/** The fetch instrumentation ends a span a little after the response, once resource timing had its chance. */
const spansEnded = (): Promise<void> => wait(450);

async function flushed(): Promise<void> {
  await ouo.flush();
  await collector.settled();
}

function click(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 20, ...init }));
}

beforeEach(() => {
  localStorage.clear();
  collector.reset();
  collector.install();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

afterEach(async () => {
  await ouo.shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** REC-1 to REC-5, SES-1, SES-2, REL-3 on one record. */
function checkRecord(l: CapturedLog): void {
  expect(l.eventName, "EventName is set").not.toBe("");
  expect(l.attributes["event.name"], "no deprecated event.name attribute").toBeUndefined();
  expect(l.attributes["session.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(l.attributes["ouo.view.id"]).toMatch(/^[\w-]+$/);
  expect(typeof l.attributes["browser.document.url.full"]).toBe("string");
  expect(l.scope).toBe("ouo.rum");
  expect(l.schemaUrl).toBe(SCHEMA);
  expect(BigInt(l.timeUnixNano)).toBeGreaterThan(0n);
  expect(BigInt(l.observedTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(l.timeUnixNano));
  for (const forbidden of ["session.id", "ouo.view.id", "browser.document.url.full", "enduser.id", "device.id", "service.instance.id", "app.installation.id"]) {
    expect(l.resource[forbidden], `${forbidden} is not on the resource`).toBeUndefined();
  }
  const allowed = /^(ouo\.|session\.|browser\.|url\.|exception\.|code\.|enduser\.|cart\.|plan$|tenant$)/;
  for (const key of Object.keys(l.attributes)) expect(key, "attribute names are OTel's or ouo.-prefixed").toMatch(allowed);
}

describe("sessions and records on the wire", () => {
  it("session.start is the first record, once, with the sample rate; every record follows the record rules", async () => {
    ouo.init(base);
    ouo.recordEvent("cart.add", { "cart.size": 2 });
    await flushed();
    const logs = collector.logs;
    expect(logs[0]!.eventName).toBe("session.start");
    expect(collector.events("session.start")).toHaveLength(1);
    expect(logs[0]!.attributes["ouo.session.sample_rate"]).toBe(1);
    expect(logs[0]!.attributes["session.previous_id"]).toBeUndefined();
    expect(logs.map((l) => l.eventName)).toEqual(["session.start", "browser.navigation", "cart.add"]);
    for (const l of logs) checkRecord(l);
    expect(new Set(logs.map((l) => l.attributes["session.id"])).size).toBe(1);
    expect(logs[0]!.attributes["session.id"]).toBe(ouo.getSessionId());
    expect(logs[0]!.severityText).toBe("INFO");
  });

  it("resource: service, SDK identity and environment only (RES-0 to RES-3)", async () => {
    ouo.init(base);
    await flushed();
    const r = collector.logs[0]!.resource;
    expect(r).toMatchObject({
      "service.name": "web-store",
      "service.version": "1.2.3",
      "deployment.environment.name": "test",
      "telemetry.sdk.name": "@ouo11y/browser",
      "telemetry.sdk.language": "webjs",
    });
    expect(r["telemetry.sdk.version"]).toBe(ouo.SDK_VERSION);
    // jsdom has no userAgentData: the user agent stands in for browser.brands.
    expect(typeof r["user_agent.original"]).toBe("string");
  });

  it("only OTLP to the configured endpoint, gzip when large, credential in the header only (REL-2, REL-6, CFG-3)", async () => {
    ouo.init(base);
    for (let i = 0; i < 40; i++) ouo.recordEvent("cart.add", { "cart.size": i });
    await flushed();
    expect(collector.requests.length).toBeGreaterThan(0);
    for (const r of collector.requests) {
      expect(r.url).toMatch(/^http:\/\/collector\.test:4318\/v1\/(logs|traces)$/);
      expect(r.url).not.toContain(TOKEN);
      expect(r.headers["authorization"]).toBe(`Basic ${btoa(`web-store:${TOKEN}`)}`);
      expect(r.headers["content-type"]).toBe("application/json");
    }
    expect(collector.requests.some((r) => r.headers["content-encoding"] === "gzip")).toBe(true);
    expect(collector.requests.some((r) => r.url.includes("metrics"))).toBe(false);
    expect(JSON.stringify(collector.logs)).not.toContain(TOKEN);
  });

  it("restartSession links the sessions; session.previous_id is on session.start only (SES-4, SES-7)", async () => {
    ouo.init(base);
    const first = ouo.getSessionId()!;
    ouo.restartSession();
    const second = ouo.getSessionId()!;
    ouo.recordEvent("cart.add");
    await flushed();
    expect(second).not.toBe(first);
    const names = collector.logs.map((l) => `${l.eventName}:${String(l.attributes["session.id"]).slice(0, 4)}`);
    expect(names).toEqual([`session.start:${first.slice(0, 4)}`, `browser.navigation:${first.slice(0, 4)}`, `session.end:${first.slice(0, 4)}`, `session.start:${second.slice(0, 4)}`, `cart.add:${second.slice(0, 4)}`]);
    const end = collector.events("session.end")[0]!;
    expect(end.attributes["ouo.session.end_reason"]).toBe("manual");
    expect(collector.events("session.start")[1]!.attributes["session.previous_id"]).toBe(first);
    for (const l of collector.logs.filter((x) => x.eventName !== "session.start")) expect(l.attributes["session.previous_id"]).toBeUndefined();
  });

  it("shutdown ends the session with reason shutdown and init works again (LIF-4, LIF-5)", async () => {
    ouo.init(base);
    const first = ouo.getSessionId();
    await ouo.shutdown();
    await collector.settled();
    expect(collector.events("session.end").map((e) => e.attributes["ouo.session.end_reason"])).toEqual(["shutdown"]);
    expect(ouo.getSessionId()).toBeUndefined();
    ouo.init(base);
    expect(ouo.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    expect(ouo.getSessionId()).not.toBe(first);
    await flushed();
    expect(collector.events("session.start")[1]!.attributes["session.previous_id"]).toBe(first);
  });
});

describe("sampling and the bypass set (SMP-3, SMP-5 to SMP-7, SES-10)", () => {
  it("an unsampled session sends only unhandled errors, marked and capped", async () => {
    ouo.init({ ...base, sampling: { sessionRate: 0, bypass: { perSessionCap: 3 } } });
    ouo.recordEvent("cart.add");
    ouo.recordException(new Error("handled"));
    for (let i = 0; i < 5; i++) window.dispatchEvent(new ErrorEvent("error", { error: new Error(`boom ${i}`), message: `boom ${i}` }));
    await fetch("http://api.test/items");
    await spansEnded();
    await flushed();
    expect(collector.logs.map((l) => l.eventName)).toEqual(["exception", "exception", "exception"]);
    for (const l of collector.logs) {
      expect(l.attributes["ouo.sampling.bypass"]).toBe(true);
      expect(l.attributes["ouo.exception.handled"]).toBe(false);
      expect(l.attributes["session.id"]).toBe(ouo.getSessionId());
    }
    expect(collector.spans).toHaveLength(0);
    expect(ouo.diagnostics().dropped).toContainEqual({ signal: "exception", reason: "bypass_cap", count: 2 });
  });

  it("the request still carries traceparent with the sampled flag clear (SMP-4)", async () => {
    history.replaceState(null, "", "/");
    ouo.init({ ...base, sampling: { sessionRate: 0 }, propagation: { urls: ["http://api.test/*"] } });
    await fetch("http://api.test/items");
    expect(collector.app[0]!.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  });

  it("without a valid session ordinary records are dropped and counted; an unhandled error goes out marked expired", async () => {
    // A page that was never visible and never touched has no session.
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    ouo.init(base);
    expect(ouo.getSessionId()).toBeUndefined();
    ouo.recordEvent("cart.add");
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("background"), message: "background" }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await flushed();
    expect(collector.logs.map((l) => l.eventName)).toEqual(["exception"]);
    expect(collector.logs[0]!.attributes["ouo.session.expired"]).toBe(true);
    expect(collector.logs[0]!.attributes["session.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(collector.events("session.start")).toHaveLength(0);
    expect(ouo.diagnostics().dropped).toContainEqual({ signal: "cart.add", reason: "no_session", count: 1 });
  });
});

describe("errors (SIG-08, SIG-34, API-6)", () => {
  it("window errors and rejections are unhandled exceptions with source, stack and code location", async () => {
    ouo.init(base);
    const err = new TypeError("x is undefined");
    window.dispatchEvent(new ErrorEvent("error", { error: err, message: err.message, filename: "http://localhost/app.js?v=9", lineno: 12, colno: 7 }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("rejected");
    window.dispatchEvent(rejection);
    await flushed();
    const [a, b] = collector.events("exception");
    expect(a!.severityText).toBe("ERROR");
    expect(a!.attributes).toMatchObject({
      "exception.type": "TypeError",
      "exception.message": "x is undefined",
      "ouo.exception.source": "error",
      "ouo.exception.handled": false,
      "code.file.path": "http://localhost/app.js?v=REDACTED",
      "code.line.number": 12,
      "code.column.number": 7,
    });
    expect(String(a!.attributes["exception.stacktrace"])).toContain("TypeError");
    expect(b!.attributes).toMatchObject({ "exception.message": "rejected", "ouo.exception.source": "unhandledrejection", "ouo.exception.handled": false });
    for (const e of [a!, b!]) {
      expect(e.attributes["ouo.exception.fingerprint"]).toBeUndefined();
      checkRecord(e);
    }
  });

  it("recordException is manual and handled, takes a fingerprint, and the same error is not reported twice", async () => {
    ouo.init(base);
    const err = new Error("handled");
    ouo.recordException(err, { "ouo.exception.fingerprint": "checkout-failed", plan: "pro" });
    window.dispatchEvent(new ErrorEvent("error", { error: err, message: err.message }));
    ouo.recordException("a string", { "ouo.exception.handled": false });
    await flushed();
    const ex = collector.events("exception").sort((a) => (a.attributes["ouo.exception.handled"] ? -1 : 1));
    expect(ex).toHaveLength(2);
    expect(ex[0]!.attributes).toMatchObject({ "ouo.exception.source": "manual", "ouo.exception.handled": true, "ouo.exception.fingerprint": "checkout-failed", plan: "pro" });
    expect(ex[1]!.attributes).toMatchObject({ "ouo.exception.source": "manual", "ouo.exception.handled": false, "exception.message": "a string" });
  });

  it("console.error and failed resource loads are not exceptions", async () => {
    ouo.init(base);
    const original = console.error;
    console.error = () => undefined;
    console.error("something", new Error("logged"));
    console.error = original;
    const img = document.createElement("img");
    document.body.appendChild(img);
    img.dispatchEvent(new Event("error"));
    await flushed();
    expect(collector.events("exception")).toHaveLength(0);
  });

  it("a flood of errors is rate limited and the drops are reported (ERR-7)", async () => {
    ouo.init(base);
    for (let i = 0; i < 50; i++) ouo.recordException(new Error(`e${i}`));
    await flushed();
    expect(collector.events("exception")).toHaveLength(30);
    await wait(300);
    await flushed();
    const dropped = collector.events("ouo.sdk.dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.attributes).toMatchObject({ "ouo.sdk.drop.signal": "exception", "ouo.sdk.drop.reason": "rate_limited", "ouo.sdk.drop.count": 20 });
    await wait(300);
    await flushed();
    expect(collector.events("ouo.sdk.dropped")).toHaveLength(1);
  });
});

describe("clicks and frustration (SIG-10, SIG-13, SIG-38, SIG-39)", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"><button id="buy" class="primary" data-otel-action="buy" data-secret="s3cret">Buy secret thing</button><button id="dead">Does nothing</button><input id="name" value="Jane Doe"></main>`;
  });

  it("a click is one event with position, tag, viewport and selector; no text, no span", async () => {
    ouo.init(base);
    click(document.getElementById("buy")!, { clientX: 33, clientY: 44 });
    await flushed();
    const [c] = collector.events("browser.user_action.click");
    expect(c!.attributes).toMatchObject({
      "browser.page.x": 33,
      "browser.page.y": 44,
      "browser.tag_name": "button",
      "browser.css_selector": "button#buy",
      "browser.mouse_event.button": 0,
      "browser.element.attributes": "data-otel-action=buy",
      "ouo.viewport.width": window.innerWidth,
      "ouo.viewport.height": window.innerHeight,
    });
    checkRecord(c!);
    expect(JSON.stringify(collector.logs)).not.toMatch(/Buy secret thing|s3cret|primary|Jane Doe/);
    expect(collector.spans).toHaveLength(0);
  });

  it("four fast clicks on one element are a rage click, reported once with the count", async () => {
    ouo.init(base);
    const el = document.getElementById("buy")!;
    for (let i = 0; i < 5; i++) click(el);
    await wait(1200);
    await flushed();
    expect(collector.events("browser.user_action.click")).toHaveLength(5);
    const rage = collector.events("ouo.user_action.frustration").filter((f) => f.attributes["ouo.user_action.frustration.type"] === "rage");
    expect(rage).toHaveLength(1);
    expect(rage[0]!.attributes).toMatchObject({ "ouo.user_action.frustration.click_count": 5, "browser.tag_name": "button", "browser.css_selector": "button#buy" });
  });

  it("three clicks are not rage", async () => {
    ouo.init(base);
    for (let i = 0; i < 3; i++) click(document.getElementById("buy")!);
    await wait(1200);
    await flushed();
    expect(collector.events("ouo.user_action.frustration").filter((f) => f.attributes["ouo.user_action.frustration.type"] === "rage")).toHaveLength(0);
  });

  it("a click that changes nothing is dead; one that changes the DOM, navigates or sends a request is not", async () => {
    ouo.init(base);
    const dead = document.getElementById("dead")!;
    const buy = document.getElementById("buy")!;
    buy.addEventListener("click", () => document.body.appendChild(document.createElement("p")));
    click(buy);
    await wait(2200);
    click(dead);
    await wait(2200);
    dead.addEventListener("click", () => void fetch("http://api.test/x"), { once: true });
    click(dead);
    await wait(2200);
    await flushed();
    const frustration = collector.events("ouo.user_action.frustration");
    expect(frustration.map((f) => [f.attributes["ouo.user_action.frustration.type"], f.attributes["browser.css_selector"]])).toEqual([["dead", "button#dead"]]);
  }, 15_000);

  it("a click followed by an unhandled error is an error click", async () => {
    ouo.init(base);
    click(document.getElementById("buy")!);
    await wait(20);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("after click"), message: "after click" }));
    await wait(2200);
    await flushed();
    expect(collector.events("ouo.user_action.frustration").map((f) => f.attributes["ouo.user_action.frustration.type"])).toEqual(["error"]);
  });
});

describe("navigation and views (SIG-14, SIG-18, REC-2, API-5)", () => {
  it("one browser.navigation per page load and per History navigation, each with a new view id; hash changes are off", async () => {
    history.replaceState(null, "", "/start?token=abc");
    ouo.init(base);
    history.pushState(null, "", "/products/42?ref=mail");
    history.replaceState({ scroll: 1 }, "", "/products/42?ref=mail");
    history.pushState(null, "", "/products/42?ref=mail#reviews");
    history.replaceState(null, "", "/cart");
    ouo.recordEvent("cart.add");
    await flushed();
    const nav = collector.events("browser.navigation");
    expect(nav.map((n) => [n.attributes["url.full"], n.attributes["browser.navigation.same_document"], n.attributes["browser.navigation.hash_change"], n.attributes["browser.navigation.type"]])).toEqual([
      ["http://localhost:3000/start?token=REDACTED", false, false, "push"],
      ["http://localhost:3000/products/42?ref=REDACTED", true, false, "push"],
      ["http://localhost:3000/cart", true, false, "replace"],
    ]);
    const views = nav.map((n) => n.attributes["ouo.view.id"]);
    expect(new Set(views).size).toBe(3);
    const custom = collector.events("cart.add")[0]!;
    expect(custom.attributes["ouo.view.id"]).toBe(views[2]);
    expect(custom.attributes["browser.document.url.full"]).toBe("http://localhost:3000/cart");
    for (const n of nav) checkRecord(n);
  });

  it("trackNavigation names the navigation the History hook just reported: one signal", async () => {
    ouo.init(base);
    history.pushState(null, "", "/products/42");
    ouo.trackNavigation("/products/:id");
    ouo.recordEvent("cart.add");
    await flushed();
    expect(collector.events("browser.navigation")).toHaveLength(2);
    expect(collector.events("cart.add")[0]!.attributes["ouo.view.name"]).toBe("/products/:id");
  });

  it("trackNavigation alone behaves like an automatic navigation, new view id included", async () => {
    ouo.init(base);
    await wait(5);
    ouo.trackNavigation("checkout", { url: "/checkout/step-2?email=a@b.c", id: "view-abc" });
    ouo.recordEvent("cart.add");
    await flushed();
    const nav = collector.events("browser.navigation");
    expect(nav).toHaveLength(2);
    expect(nav[1]!.attributes).toMatchObject({ "url.full": "http://localhost:3000/checkout/step-2?email=REDACTED", "browser.navigation.same_document": true, "ouo.view.id": "view-abc", "ouo.view.name": "checkout" });
    expect(collector.events("cart.add")[0]!.attributes["ouo.view.id"]).toBe("view-abc");
  });

  it("the patched history methods behave like the originals and are restored at shutdown", async () => {
    const push = history.pushState;
    const replace = history.replaceState;
    ouo.init(base);
    expect(history.pushState).not.toBe(push);
    expect(history.pushState({ a: 1 }, "", "/x")).toBeUndefined();
    expect(history.state).toEqual({ a: 1 });
    expect(() => history.pushState(null, "", "http://other.test/")).toThrow();
    await ouo.shutdown();
    expect(history.pushState).toBe(push);
    expect(history.replaceState).toBe(replace);
  });
});

describe("fetch and XHR spans, propagation (SIG-21, SIG-40, PRP-1 to PRP-6, REC-6)", () => {
  it("one client span per request, named by method, its own trace, sanitised URL, no events, scope ouo.rum", async () => {
    ouo.init(base);
    await fetch("http://localhost:3000/api/items?user=jane");
    await fetch("http://localhost:3000/api/cart", { method: "POST" });
    await spansEnded();
    await flushed();
    expect(collector.spans.map((s) => s.name)).toEqual(["GET", "POST"]);
    const [a, b] = collector.spans;
    expect(a!.kind).toBe(3);
    expect(a!.traceId).not.toBe(b!.traceId);
    expect(a!.parentSpanId ?? "").toBe("");
    expect(a!.attributes).toMatchObject({ "http.request.method": "GET", "url.full": "http://localhost:3000/api/items?user=REDACTED", "session.id": ouo.getSessionId() });
    expect(a!.attributes["ouo.view.id"]).toBeDefined();
    expect(a!.attributes["browser.document.url.full"]).toBeDefined();
    for (const s of collector.spans) {
      expect(s.events).toEqual([]);
      expect(s.scope).toBe("ouo.rum");
      expect(s.schemaUrl).toBe(SCHEMA);
    }
    // The SDK's own exports are not traced.
    expect(collector.spans.some((s) => String(s.attributes["url.full"]).includes("collector.test"))).toBe(false);
  });

  it("traceparent goes to the same origin and to configured URLs only, with random trace ids and the sampled flag", async () => {
    ouo.init({ ...base, propagation: { urls: ["http://api.test/*"] } });
    await fetch("http://localhost:3000/api/a");
    await fetch("http://api.test/b");
    await fetch("http://third-party.test/c");
    const [same, allowed, other] = collector.app;
    expect(same!.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(allowed!.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(same!.headers["traceparent"]!.slice(3, 35)).not.toBe(allowed!.headers["traceparent"]!.slice(3, 35));
    expect(other!.headers["traceparent"]).toBeUndefined();
    for (const r of collector.app) expect(r.headers["baggage"]).toBeUndefined();
  });

  it("an app-set traceparent and baggage are never overwritten (PRP-3)", async () => {
    ouo.init({ ...base, propagation: { sessionBaggage: true } });
    const mine = "00-11111111111111111111111111111111-2222222222222222-01";
    await fetch("http://localhost:3000/api/a", { headers: { traceparent: mine, baggage: "tenant=acme" } });
    await fetch(new Request("http://localhost:3000/api/b", { headers: { traceparent: mine } }));
    expect(collector.app[0]!.headers).toMatchObject({ traceparent: mine, baggage: "tenant=acme" });
    expect(collector.app[1]!.headers["traceparent"]).toBe(mine);
  });

  it("session baggage is sent only when configured, with the record's session id (PRP-6)", async () => {
    ouo.init({ ...base, propagation: { sessionBaggage: true } });
    await fetch("http://localhost:3000/api/a");
    await fetch("http://third-party.test/c");
    expect(collector.app[0]!.headers["baggage"]).toBe(`session.id=${ouo.getSessionId()}`);
    expect(collector.app[1]!.headers["baggage"]).toBeUndefined();
  });

  it("XHR: an app-set traceparent is kept as it is", async () => {
    const sent: Array<[string, string]> = [];
    const original = XMLHttpRequest.prototype.setRequestHeader;
    ouo.init(base);
    const patched = XMLHttpRequest.prototype.setRequestHeader;
    expect(patched).not.toBe(original);
    const xhr = new XMLHttpRequest();
    const spy = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => undefined);
    // Record what reaches the platform function.
    XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, n: string, v: string) {
      sent.push([n.toLowerCase(), v]);
      return patched.call(this, n, v);
    };
    xhr.open("GET", "http://localhost:3000/api/x");
    xhr.setRequestHeader("traceparent", "00-11111111111111111111111111111111-2222222222222222-01");
    xhr.setRequestHeader("x-app", "1");
    xhr.send();
    XMLHttpRequest.prototype.setRequestHeader = patched;
    spy.mockRestore();
    await ouo.shutdown();
    expect(XMLHttpRequest.prototype.setRequestHeader).toBe(original);
    expect(sent.filter(([n]) => n === "traceparent")).toHaveLength(1);
  });

  it("requests do not extend the session (SES-5) and clicks do not parent them (SIG-38, SIG-41)", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    ouo.init(base);
    const go = document.getElementById("go")!;
    go.addEventListener("click", () => void fetch("http://localhost:3000/api/after-click"));
    click(go);
    await spansEnded();
    await flushed();
    expect(collector.spans).toHaveLength(1);
    expect(collector.spans[0]!.parentSpanId ?? "").toBe("");
    expect(collector.spans.some((s) => s.name === "click" || s.name === "soft-navigation")).toBe(false);
  });
});

describe("public API: custom events, global attributes, user, beforeSend, providers", () => {
  it("rejects reserved names, counts them, and never throws (API-3)", async () => {
    ouo.init(base);
    ouo.recordEvent("session.start");
    ouo.recordEvent("ouo.replay.chunk", { a: 1 });
    ouo.recordEvent("checkout.done", { "session.id": "fake", "ouo.view.id": "fake", plan: "pro" }, { total: 12.5, items: ["a", "b"] });
    ouo.setGlobalAttributes({ tenant: "acme", "ouo.x": 1 } as never);
    ouo.recordEvent("cart.add");
    await flushed();
    expect(collector.events("session.start")).toHaveLength(1);
    expect(collector.events("ouo.replay.chunk")).toHaveLength(0);
    const done = collector.events("checkout.done")[0]!;
    expect(done.attributes["session.id"]).toBe(ouo.getSessionId());
    expect(done.attributes["plan"]).toBe("pro");
    expect(done.attributes["ouo.view.id"]).not.toBe("fake");
    expect(collector.events("cart.add")[0]!.attributes).toMatchObject({ tenant: "acme" });
    expect(collector.events("cart.add")[0]!.attributes["ouo.x"]).toBeUndefined();
    const dropped = ouo.diagnostics().dropped;
    expect(dropped).toContainEqual({ signal: "session.start", reason: "reserved_name", count: 1 });
    expect(dropped).toContainEqual({ signal: "ouo.replay.chunk", reason: "reserved_name", count: 1 });
    expect(dropped).toContainEqual({ signal: "attribute", reason: "reserved_name", count: 3 });
  });

  it("enduser.id appears only after setUser and goes away with null (PRV-13)", async () => {
    ouo.init(base);
    ouo.recordEvent("cart.add");
    ouo.setUser("user-7");
    ouo.recordEvent("cart.add");
    ouo.setUser(null);
    ouo.recordEvent("cart.add");
    await flushed();
    expect(collector.events("cart.add").map((e) => e.attributes["enduser.id"])).toEqual([undefined, "user-7", undefined]);
    for (const l of collector.logs) {
      expect(l.attributes["user.id"]).toBeUndefined();
      expect(l.attributes["enduser.pseudo.id"]).toBeUndefined();
    }
  });

  it("beforeSend runs on events and spans, may modify or drop, and a throwing hook changes nothing (CFG-4)", async () => {
    const seen: string[] = [];
    ouo.init({
      ...base,
      beforeSend: (r) => {
        seen.push(`${r.type}:${r.name}`);
        if (r.name === "secret.event") return null;
        if (r.name === "explode") throw new Error("hook bug");
        if (r.type === "span") r.attributes["url.full"] = "scrubbed";
        if (r.name === "exception") return { ...r, attributes: { ...r.attributes, "exception.message": "[scrubbed]" } };
        return r;
      },
    });
    ouo.recordEvent("secret.event");
    ouo.recordEvent("explode", { plan: "pro" });
    ouo.recordException(new Error("card 4111 1111 1111 1111"));
    await fetch("http://localhost:3000/api/items");
    await spansEnded();
    await flushed();
    expect(collector.events("secret.event")).toHaveLength(0);
    expect(collector.events("explode")[0]!.attributes["plan"]).toBe("pro");
    expect(collector.events("exception")[0]!.attributes["exception.message"]).toBe("[scrubbed]");
    expect(collector.events("exception")[0]!.attributes["session.id"]).toBe(ouo.getSessionId());
    expect(collector.spans[0]!.attributes["url.full"]).toBe("scrubbed");
    expect(seen).toContain("span:GET");
    expect(ouo.diagnostics().dropped).toContainEqual({ signal: "secret.event", reason: "before_send", count: 1 });
  });

  it("the exposed providers feed the same pipeline with session attributes; the OTel globals are untouched (REL-4, REL-5)", async () => {
    const { trace } = await import("@opentelemetry/api");
    const { logs } = await import("@opentelemetry/api-logs");
    const globalTracer = trace.getTracerProvider();
    const globalLogger = logs.getLoggerProvider();
    ouo.init(base);
    expect(trace.getTracerProvider()).toBe(globalTracer);
    expect(logs.getLoggerProvider()).toBe(globalLogger);
    const span = ouo.getTracerProvider().getTracer("app").startSpan("checkout");
    span.end();
    ouo.getLoggerProvider().getLogger("app").emit({ body: "order placed", attributes: { plan: "pro" } });
    await flushed();
    const s = collector.spans.find((x) => x.name === "checkout")!;
    expect(s.attributes["session.id"]).toBe(ouo.getSessionId());
    expect(s.scope).toBe("app");
    const l = collector.logs.find((x) => x.body === "order placed")!;
    expect(l.attributes).toMatchObject({ plan: "pro", "session.id": ouo.getSessionId() });
    expect(l.attributes["ouo.view.id"]).toBeDefined();
    expect(l.scope).toBe("app");
  });

  it("an exception recorded inside an active span carries its trace and span ids (SIG-33)", async () => {
    ouo.init(base);
    const tracer = ouo.getTracerProvider().getTracer("app");
    let ids = { traceId: "", spanId: "" };
    const { context, trace } = await import("@opentelemetry/api");
    const span = tracer.startSpan("checkout");
    context.with(trace.setSpan(context.active(), span), () => {
      ids = span.spanContext();
      ouo.recordException(new Error("inside"));
    });
    span.end();
    await flushed();
    const ex = collector.events("exception")[0]!;
    expect(ex.traceId).toBe(ids.traceId);
    expect(ex.spanId).toBe(ids.spanId);
  });
});

describe("consent (PRV-1 to PRV-4)", () => {
  it("pending: nothing is sent or stored; grant releases what was buffered", async () => {
    ouo.init({ ...base, consent: { required: true } });
    ouo.recordEvent("cart.add");
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("early"), message: "early" }));
    await wait(400);
    expect(collector.requests).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    ouo.setConsent({ telemetry: true });
    await flushed();
    // Errors travel in their own batch, so arrival order is not creation order: Timestamp is.
    const byTime = [...collector.logs].sort((a, b) => (BigInt(a.timeUnixNano) < BigInt(b.timeUnixNano) ? -1 : BigInt(a.timeUnixNano) > BigInt(b.timeUnixNano) ? 1 : 0));
    expect(byTime[0]!.eventName).toBe("session.start");
    expect(collector.logs.map((l) => l.eventName).sort()).toEqual(["browser.navigation", "cart.add", "exception", "session.start"]);
    expect(localStorage.getItem("ouo.session")).not.toBeNull();
  });

  it("denied while pending: the buffer is discarded and nothing is ever sent", async () => {
    ouo.init({ ...base, consent: { required: true } });
    ouo.recordEvent("cart.add");
    ouo.setConsent({ telemetry: false });
    ouo.recordEvent("cart.add");
    await wait(400);
    await ouo.flush();
    expect(collector.requests).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect(ouo.getSessionId()).toBeUndefined();
  });

  it("withdrawal ends the session with reason consent, clears storage, and a later grant starts a session with no previous id", async () => {
    ouo.init(base);
    const first = ouo.getSessionId();
    ouo.recordEvent("cart.add");
    ouo.setConsent({ telemetry: false });
    await wait(50);
    await collector.settled();
    expect(collector.events("session.end")[0]!.attributes["ouo.session.end_reason"]).toBe("consent");
    expect(localStorage.getItem("ouo.session")).toBeNull();
    const before = collector.requests.length;
    ouo.recordEvent("cart.add");
    await wait(400);
    expect(collector.requests.length).toBe(before);
    ouo.setConsent({ telemetry: true });
    ouo.recordEvent("cart.add");
    await flushed();
    const starts = collector.events("session.start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.attributes["session.id"]).not.toBe(first);
    expect(starts[1]!.attributes["session.previous_id"]).toBeUndefined();
  });
});

describe("delivery (TRN-4, TRN-6, TRN-9 to TRN-11)", () => {
  it("retries 503 with the same body, drops 400 and counts it, honours partial success", async () => {
    ouo.init({ ...base, transport: { flushIntervalMs: 250, retry: { initialMs: 20, maxMs: 50 } } });
    collector.next({ status: 503 }, { status: 503 });
    ouo.recordEvent("cart.add");
    await ouo.flush();
    await until(() => collector.events("cart.add").length === 1);
    // Two refused attempts and the accepted one, all with the same bytes (TRN-10).
    const tries = collector.requests.filter((r) => r.url.endsWith("/v1/logs")).slice(-3);
    expect(tries).toHaveLength(3);
    expect(new Set(tries.map((r) => Array.from(r.body).join(","))).size).toBe(1);

    collector.next({ status: 400 });
    ouo.recordEvent("rejected.event");
    await flushed();
    await wait(100);
    expect(collector.events("rejected.event")).toHaveLength(0);
    expect(ouo.diagnostics().dropped).toContainEqual({ signal: "rejected.event", reason: "rejected_status", count: 1 });

    collector.next({ status: 200, body: JSON.stringify({ partialSuccess: { rejectedLogRecords: "2" } }) });
    ouo.recordEvent("partial.event");
    await flushed();
    expect(ouo.diagnostics().dropped).toContainEqual({ signal: "logs", reason: "partial_rejected", count: 2 });
  });

  it("a full queue evicts the oldest ordinary records first and keeps unhandled errors", async () => {
    ouo.init({ ...base, transport: { flushIntervalMs: 60_000, maxQueueRecords: 16, retry: { initialMs: 10_000, maxMs: 10_000 } } });
    collector.setAlways({ fail: true });
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("keep me"), message: "keep me" }));
    for (let i = 0; i < 40; i++) ouo.recordEvent("filler", { n: i } as never);
    collector.setAlways(undefined);
    await flushed();
    await until(() => collector.events("exception").length === 1, 3000).catch(() => undefined);
    expect(collector.events("exception")).toHaveLength(1);
    expect(collector.logs.length).toBeLessThanOrEqual(16);
    const evicted = ouo.diagnostics().dropped.filter((d) => d.reason === "queue_full");
    expect(evicted.reduce((n, d) => n + d.count, 0)).toBeGreaterThan(20);
    expect(evicted.some((d) => d.signal === "exception")).toBe(false);
  });

  it("no request is sent when there is nothing to send, and batches respect maxBatchRecords", async () => {
    ouo.init({ ...base, transport: { flushIntervalMs: 250, maxBatchRecords: 10 } });
    await flushed();
    const before = collector.requests.length;
    await ouo.flush();
    await wait(300);
    expect(collector.requests.length).toBe(before);
    for (let i = 0; i < 25; i++) ouo.recordEvent("cart.add");
    await flushed();
    for (const r of collector.requests) expect(r.body.byteLength).toBeGreaterThan(0);
    expect(collector.events("cart.add")).toHaveLength(25);
    expect(collector.requests.length - before).toBeGreaterThanOrEqual(3);
  });
});
