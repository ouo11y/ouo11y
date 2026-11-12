import { describe, expect, it } from "vitest";
import { matchesUrl, resolveConfig } from "../src/config";
import { DropCounter } from "../src/core/drops";
import { isSessionId, newSessionId, newViewId, sampledAt } from "../src/core/ids";
import { appAttributes, MAX_STACK_BYTES, MAX_STRING_BYTES, reservedName, truncate, truncateAttributes } from "../src/core/limits";
import { cssSelector } from "../src/core/selector";
import { redactUrl, sanitizeStack, sanitizeUrl } from "../src/core/url";
import { backoffDelay, classifyStatus, parseRetryAfter, retryDelay } from "../src/transport/retry";

const policy = { queryAllow: new Set<string>(), keepFragment: false };

describe("ids and sampling (SES-1, SMP-2, SMP-8)", () => {
  it("session ids are 32 lowercase hex characters and do not repeat", () => {
    const ids = new Set(Array.from({ length: 500 }, newSessionId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isSessionId("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(false);
    expect(newViewId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("golden vectors: first 8 hex characters for the session, second 8 for replay", () => {
    const id = "40000000c0000000ffffffffffffffff"; // 0.25 and 0.75
    expect(sampledAt(id, 0.26, 0)).toBe(true);
    expect(sampledAt(id, 0.25, 0)).toBe(false);
    expect(sampledAt(id, 0.76, 8)).toBe(true);
    expect(sampledAt(id, 0.75, 8)).toBe(false);
    expect(sampledAt("ffffffff00000000" + "0".repeat(16), 1, 0)).toBe(true);
    expect(sampledAt("00000000" + "0".repeat(24), 0, 0)).toBe(false);
  });

  it("the two decisions are independent over many ids", () => {
    let both = 0;
    let session = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const id = newSessionId();
      const s = sampledAt(id, 0.5, 0);
      if (s) session++;
      if (s && sampledAt(id, 0.5, 8)) both++;
    }
    expect(session / n).toBeGreaterThan(0.44);
    expect(session / n).toBeLessThan(0.56);
    expect(both / n).toBeGreaterThan(0.2);
    expect(both / n).toBeLessThan(0.3);
  });
});

describe("URL sanitising (PRV-10, PRV-11)", () => {
  it.each([
    ["https://user:secret@shop.test/a?token=abc&q=shoes#frag", "https://REDACTED:REDACTED@shop.test/a?token=REDACTED&q=REDACTED"],
    ["https://shop.test/a", "https://shop.test/a"],
    ["/relative/path?email=a%40b.c", "/relative/path?email=REDACTED"],
    ["https://shop.test/?flag&x=", "https://shop.test/?flag&x=REDACTED"],
    ["https://shop.test/#access_token=abc", "https://shop.test/"],
  ])("%s", (input, expected) => {
    expect(redactUrl(input, policy)).toBe(expected);
  });

  it("keeps allowed query keys and, when asked, a sanitised fragment", () => {
    const p = { queryAllow: new Set(["utm_source"]), keepFragment: true };
    expect(redactUrl("https://shop.test/?utm_source=mail&id=7#/cart?coupon=X1", p)).toBe("https://shop.test/?utm_source=mail&id=REDACTED#/cart?coupon=REDACTED");
    expect(redactUrl("https://shop.test/#access_token=abc&state=1", p)).toBe("https://shop.test/#access_token=REDACTED&state=REDACTED");
    expect(redactUrl("https://shop.test/#section-2", p)).toBe("https://shop.test/#section-2");
  });

  it("runs the app hook last, and survives a hook that throws or returns nonsense", () => {
    expect(sanitizeUrl("https://shop.test/users/42?x=1", { ...policy, hook: (u) => u.replace(/\/users\/\d+/, "/users/:id") })).toBe("https://shop.test/users/:id?x=REDACTED");
    expect(
      sanitizeUrl("https://shop.test/?x=1", {
        ...policy,
        hook: () => {
          throw new Error("boom");
        },
      }),
    ).toBe("https://shop.test/?x=REDACTED");
    expect(sanitizeUrl("https://shop.test/?x=1", { ...policy, hook: (() => 42) as never })).toBe("https://shop.test/?x=REDACTED");
  });

  it("sanitises URLs inside stack frames and keeps line and column", () => {
    const stack = "Error: x\n    at f (https://shop.test/app.js?v=abc123:10:5)\n    at https://u:p@cdn.test/lib.js:2:1";
    expect(sanitizeStack(stack, policy)).toBe("Error: x\n    at f (https://shop.test/app.js?v=REDACTED:10:5)\n    at https://REDACTED:REDACTED@cdn.test/lib.js:2:1");
  });
});

describe("attribute limits and reserved names (REC-8, API-3)", () => {
  it("truncates strings at 4 KiB and stacks at 25 KiB, by UTF-8 bytes, keeping the start", () => {
    expect(truncate("a".repeat(5000), MAX_STRING_BYTES)).toHaveLength(4096);
    const cut = truncate("é".repeat(5000), MAX_STRING_BYTES);
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(MAX_STRING_BYTES);
    expect(new TextEncoder().encode(truncate("😀".repeat(3000), MAX_STRING_BYTES)).byteLength).toBeLessThanOrEqual(MAX_STRING_BYTES);
    const attrs: Record<string, unknown> = { "exception.stacktrace": "top\n" + "x".repeat(40_000), other: "y".repeat(9000), n: 1 };
    truncateAttributes(attrs);
    expect((attrs["exception.stacktrace"] as string).length).toBe(MAX_STACK_BYTES);
    expect((attrs["exception.stacktrace"] as string).startsWith("top\n")).toBe(true);
    expect((attrs["other"] as string).length).toBe(MAX_STRING_BYTES);
  });

  it("rejects reserved and unusable app attributes and counts each", () => {
    expect(reservedName("session.id")).toBe(true);
    expect(reservedName("ouo.view.id")).toBe(true);
    expect(reservedName("ouo.exception.fingerprint")).toBe(false);
    expect(reservedName("cart.size")).toBe(false);
    const rejected: string[] = [];
    const out = appAttributes({ "session.id": "x", "ouo.x": 1, ok: "v", n: 2, b: true, bad: { a: 1 }, nan: NaN, "ouo.exception.fingerprint": "fp" }, (r) => rejected.push(r));
    expect(out).toEqual({ ok: "v", n: 2, b: true, "ouo.exception.fingerprint": "fp" });
    expect(rejected.sort()).toEqual(["invalid_attribute", "invalid_attribute", "reserved_name", "reserved_name"]);
    expect(appAttributes(null, () => undefined)).toEqual({});
    expect(appAttributes("nope", () => undefined)).toEqual({});
  });
});

describe("CSS selector (PRV-9)", () => {
  it("uses tags, nth-of-type and ids only; never classes, attributes or ids with long digit runs", () => {
    document.body.innerHTML = `<main id="app"><ul class="list"><li>a</li><li class="x" data-id="77"><button class="buy" id="user-1234567">Buy</button><button>Other</button></li></ul><div id="ok-12"><span>t</span></div></main>`;
    const [first, second] = Array.from(document.querySelectorAll("button"));
    expect(cssSelector(first!)).toBe("main#app > ul > li:nth-of-type(2) > button:nth-of-type(1)");
    expect(cssSelector(second!)).toBe("main#app > ul > li:nth-of-type(2) > button:nth-of-type(2)");
    expect(cssSelector(document.querySelector("span")!)).toBe("div#ok-12 > span");
    for (const el of Array.from(document.querySelectorAll("*"))) expect(cssSelector(el)).not.toMatch(/\.|\[|1234567/);
  });
});

describe("configuration (CFG-1, CFG-2, CFG-3)", () => {
  const notes: string[] = [];
  const note = (key: string, problem: string): void => void notes.push(`${key}: ${problem}`);
  const base = { endpoint: "https://otel.test", serviceName: "shop" };

  it.each([[undefined], [null], ["x"], [{}], [{ endpoint: "https://otel.test" }], [{ serviceName: "shop" }], [{ ...base, endpoint: 7 }], [{ ...base, endpoint: "ftp://x" }], [{ ...base, serviceName: "  " }], [{ ...base, enabled: false }], [{ ...base, endpoint: "https://u:p@otel.test" }], [{ ...base, endpoint: "https://otel.test/?token=abc" }]])(
    "is off, without throwing, for %j",
    (input) => {
      expect(resolveConfig(input, note)).toBeNull();
    },
  );

  it("applies the spec defaults", () => {
    const c = resolveConfig(base, note)!;
    expect(c.logsUrl).toBe("https://otel.test/v1/logs");
    expect(c.session).toEqual({ inactivityTimeoutMs: 1_800_000, maxDurationMs: 14_400_000 });
    expect(c.sampling).toEqual({ sessionRate: 1, bypassCap: 10 });
    expect(c.replay.mode).toBe("off");
    expect(c.replay.chunkMaxBytes).toBe(256 * 1024);
    expect(c.replay.chunkMaxMs).toBe(5000);
    expect(c.replay.keyframeIntervalMs).toBe(300_000);
    expect(c.consentRequired).toBe(false);
    expect(c.propagation).toEqual({ urls: [], sessionBaggage: false });
    expect(c.transport.flushIntervalMs).toBe(5000);
    expect(c.transport.maxBatchRecords).toBe(512);
    expect(c.transport.maxQueueRecords).toBe(2048);
    expect(c.transport.maxRequestBytes).toBe(1024 * 1024);
    expect(c.transport.retryMaxMs).toBe(300_000);
    expect(c.transport.persistTtlMs).toBe(72 * 3_600_000);
    expect(c.selfDisableThreshold).toBe(20);
    expect(c.instrumentations.resourceTiming).toBe(false);
    expect(c.otel.registerGlobalProviders).toBe(false);
  });

  it("clamps out-of-range values and falls back on wrong types, with a diagnostic that names the key", () => {
    notes.length = 0;
    const c = resolveConfig(
      {
        ...base,
        session: { inactivityTimeoutMs: 5, maxDurationMs: 99 * 3_600_000 },
        sampling: { sessionRate: 7, bypass: { perSessionCap: "many" } },
        replay: { mode: "video", sessionRate: -1, chunkMaxBytes: 50 * 1024 * 1024, format: 3 },
        consent: { required: "yes" },
        privacy: { urlQueryAllow: "utm_source" },
        beforeSend: "not a function",
        propagation: { urls: "https://api.test" },
        transport: { flushIntervalMs: NaN, retry: null },
        instrumentations: { clicks: 0 },
        diagnostics: { selfDisableThreshold: -3 },
      },
      note,
    )!;
    expect(c.session).toEqual({ inactivityTimeoutMs: 60_000, maxDurationMs: 24 * 3_600_000 });
    expect(c.sampling).toEqual({ sessionRate: 1, bypassCap: 10 });
    expect(c.replay.mode).toBe("off");
    expect(c.replay.sessionRate).toBe(0);
    expect(c.replay.chunkMaxBytes).toBe(1024 * 1024);
    expect(c.replay.format).toBe("structure");
    expect(c.consentRequired).toBe(false);
    expect(c.privacy.urlQueryAllow.size).toBe(0);
    expect(c.beforeSend).toBeUndefined();
    expect(c.propagation.urls).toEqual([]);
    expect(c.transport.flushIntervalMs).toBe(5000);
    expect(c.instrumentations.clicks).toBe(true);
    expect(c.selfDisableThreshold).toBe(1);
    expect(notes.length).toBeGreaterThanOrEqual(12);
  });

  it("builds the Authorization header from the project credential and never mentions it in a diagnostic", () => {
    notes.length = 0;
    const c = resolveConfig({ ...base, projectId: "shop", projectToken: "pt_canary_SECRET", headers: { "x-extra": "1", bad: 5 } }, note)!;
    expect(c.headers["Authorization"]).toBe(`Basic ${btoa("shop:pt_canary_SECRET")}`);
    expect(c.headers["x-extra"]).toBe("1");
    expect(c.logsUrl).not.toContain("SECRET");
    resolveConfig({ ...base, projectId: "a:b", projectToken: "pt_canary_SECRET" }, note);
    expect(notes.join("\n")).not.toMatch(/SECRET|canary/);
  });

  it("matches URL patterns: exact, prefix, RegExp", () => {
    expect(matchesUrl(["https://api.test/a"], "https://api.test/a")).toBe(true);
    expect(matchesUrl(["https://api.test/*"], "https://api.test/b/c")).toBe(true);
    expect(matchesUrl([/api\.test/g], "https://api.test/b")).toBe(true);
    expect(matchesUrl([/api\.test/g], "https://api.test/b")).toBe(true);
    expect(matchesUrl(["https://api.test/a"], "https://api.test/ab")).toBe(false);
  });
});

describe("responses and retries (TRN-6 to TRN-8)", () => {
  it.each([
    [200, "ok"], [204, "ok"], [429, "retry"], [503, "retry"], [502, "retry"], [504, "retry"],
    [400, "reject"], [401, "reject"], [404, "reject"], [408, "reject"], [413, "reject"], [500, "reject"], [501, "reject"],
  ])("%i is %s", (status, verdict) => {
    expect(classifyStatus(status)).toBe(verdict);
  });

  it("backoff is exponential with full jitter between initial and max", () => {
    expect(backoffDelay(1, 1000, 300_000, () => 1)).toBe(1000);
    expect(backoffDelay(4, 1000, 300_000, () => 1)).toBe(8000);
    expect(backoffDelay(4, 1000, 300_000, () => 0)).toBe(1);
    expect(backoffDelay(40, 1000, 300_000, () => 1)).toBe(300_000);
    const samples = Array.from({ length: 300 }, () => backoffDelay(3, 1000, 300_000));
    expect(Math.min(...samples)).toBeLessThan(1000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(4000);
  });

  it("Retry-After is honoured and capped at the maximum", () => {
    expect(parseRetryAfter("7", 0)).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(retryDelay(1, 7000, 1000, 300_000)).toBe(7000);
    expect(retryDelay(1, 3_600_000, 1000, 300_000)).toBe(300_000);
  });
});

describe("drop accounting (ERR-7)", () => {
  it("counts by signal and reason, reports once, and never counts its own event", () => {
    const d = new DropCounter();
    let armed = 0;
    d.onFirst(() => armed++);
    d.add("exception", "rate_limited");
    d.add("exception", "rate_limited", 2);
    d.add("span", "no_session");
    d.add("ouo.sdk.dropped", "queue_full");
    expect(armed).toBe(1);
    expect(d.take().sort((a, b) => a.signal.localeCompare(b.signal))).toEqual([
      { signal: "exception", reason: "rate_limited", count: 3 },
      { signal: "span", reason: "no_session", count: 1 },
    ]);
    expect(d.take()).toEqual([]);
    expect(d.total("exception")).toBe(3);
    expect(d.total()).toBe(4);
  });
});
