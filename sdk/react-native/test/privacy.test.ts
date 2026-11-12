/** URL sanitising (spec PRV-10, PRV-11): vectors, the hook, and what reaches the collector. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guard } from "../src/guard";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { createUrlSanitizer, redactUrl, sanitizeUrlsInText } from "../src/privacy";
import type { RUMOptions } from "../src/types";
import { attr, BACKEND, baseOptions, g, installErrorUtils, installFetchStub } from "./support/otlp";

describe("redactUrl vectors", () => {
  const allow = new Set(["page", "sort by"]);
  const vectors: Array<[string, string, string?]> = [
    ["https://api.test/items", "https://api.test/items"],
    ["https://user:secret@api.test/items", "https://REDACTED:REDACTED@api.test/items"],
    ["https://token@api.test:8443/a", "https://REDACTED:REDACTED@api.test:8443/a"],
    ["https://u:p@ss@api.test/a", "https://REDACTED:REDACTED@api.test/a"],
    ["https://api.test/a?token=abc&page=2&q=shoes", "https://api.test/a?token=REDACTED&page=2&q=REDACTED"],
    ["https://api.test/a?sort%20by=price&x=1", "https://api.test/a?sort%20by=price&x=REDACTED"],
    ["https://api.test/a?flag&empty=&k=v=w", "https://api.test/a?flag&empty=REDACTED&k=REDACTED"],
    ["https://api.test/a?email=a@b.c", "https://api.test/a?email=REDACTED"],
    ["https://api.test/a?bad=%E0%A4%A&%zz=1", "https://api.test/a?bad=REDACTED&%zz=REDACTED"],
    ["https://api.test/a#section", "https://api.test/a", "https://api.test/a#section"],
    ["https://api.test/a?x=1#access_token=abc&page=2", "https://api.test/a?x=REDACTED", "https://api.test/a?x=REDACTED#access_token=REDACTED&page=2"],
    ["https://api.test/#/route?id=7&page=1", "https://api.test/", "https://api.test/#/route?id=REDACTED&page=1"],
    ["/relative/path?secret=1#frag", "/relative/path?secret=REDACTED", "/relative/path?secret=REDACTED#frag"],
    ["not a url", "not a url"],
    ["", ""],
    ["myapp://u:p@open/item?id=5", "myapp://REDACTED:REDACTED@open/item?id=REDACTED"],
  ];
  it.each(vectors)("%s", (input, expected, withFragment) => {
    expect(redactUrl(input, allow)).toBe(expected);
    expect(redactUrl(input, allow, true)).toBe(withFragment ?? expected);
    // Idempotent.
    expect(redactUrl(expected, allow)).toBe(expected);
  });
});

describe("createUrlSanitizer", () => {
  it("runs the hook on the redacted URL, once, and survives a hook that throws or returns junk", () => {
    const hook = vi.fn((url: string) => url.replace(/\/users\/\d+/, "/users/:id"));
    const sanitize = createUrlSanitizer({ queryAllow: ["page"], hook });
    const out = sanitize("https://u:p@api.test/users/42?token=t&page=3#top");
    expect(out).toBe("https://REDACTED:REDACTED@api.test/users/:id?token=REDACTED&page=3");
    expect(hook).toHaveBeenCalledWith("https://REDACTED:REDACTED@api.test/users/42?token=REDACTED&page=3");
    // Its own output is a fixed point: not hooked again.
    expect(sanitize(out)).toBe(out);
    expect(hook).toHaveBeenCalledTimes(1);

    guard.reset();
    const throwing = createUrlSanitizer({ hook: () => { throw new Error("hook bug"); } });
    expect(throwing("https://a.test/?k=v")).toBe("https://a.test/?k=REDACTED");
    const junk = createUrlSanitizer({ hook: (() => 42) as never });
    expect(junk("https://a.test/?k=v")).toBe("https://a.test/?k=REDACTED");
    expect(guard.errors).toBe(0);
    for (const v of [undefined, null, 5, {}]) expect(createUrlSanitizer()(v as never)).toBe(v);
  });

  it("sanitises URLs inside a stack trace and keeps line and column", () => {
    const sanitize = createUrlSanitizer();
    const stack = ["Error: boom", "    at load (https://cdn.test/app.js?sig=abc123:10:5)", "    at https://u:p@cdn.test/b.js#x:7", "    at native (app:///main.jsbundle:1:2)", "no url here"].join("\n");
    expect(sanitizeUrlsInText(stack, sanitize)).toBe(
      ["Error: boom", "    at load (https://cdn.test/app.js?sig=REDACTED:10:5)", "    at https://REDACTED:REDACTED@cdn.test/b.js:7", "    at native (app:///main.jsbundle:1:2)", "no url here"].join("\n"),
    );
  });
});

describe("what is sent", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    installErrorUtils();
    delete g.__ouoSessionProcessState;
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete g.ErrorUtils;
    delete g.__ouoSessionProcessState;
  });

  it("url.full of request spans and events, their bodies, last events and stack traces carry no secret; the request itself is untouched", async () => {
    const captured = installFetchStub();
    const rum = initRUM({
      ...baseOptions(),
      privacy: { urlQueryAllow: ["page"] },
      sanitizeUrl: (url: string) => url.replace(/\/orders\/\d+/, "/orders/:id"),
    } as RUMOptions) as RUMInternal;
    await rum.ready;
    await fetch(`${BACKEND.replace("://", "://bob:hunter2@")}/orders/991?card=4111111111111111&page=2#pay`);
    await fetch(`${BACKEND}/orders/5?fail=500&ssn=123-45-6789`);
    const err = new Error("load failed");
    err.stack = `Error: load failed\n    at fetchIt (https://cdn.test/chunk.js?auth=s3cr3t:3:9)`;
    rum.recordException(err);
    rum.getTracerProvider().getTracer("app").startSpan("host", { attributes: { "url.full": "https://x.test/?pw=hunter2" } }).end();
    await rum.flush();

    const everything = JSON.stringify([captured.logs, captured.spans]);
    for (const secret of ["hunter2", "4111111111111111", "123-45-6789", "s3cr3t", "bob", "#pay", "/orders/991"]) expect(everything, secret).not.toContain(secret);
    const span = captured.spans.find((s) => s.name === "HTTP GET")!;
    expect(attr(span.attributes, "url.full")).toBe(`${BACKEND.replace("://", "://REDACTED:REDACTED@")}/orders/:id?card=REDACTED&page=2`);
    const request = captured.byName("http.request")[0]!;
    expect(request.body?.stringValue).toBe(`GET ${attr(span.attributes, "url.full")}`);
    const failed = captured.byName("http.request.failed")[0]!;
    expect(attr(failed.attributes, "url.full")).toBe(`${BACKEND}/orders/:id?fail=REDACTED&ssn=REDACTED`);
    expect(String(attr(captured.byName("exception")[0]!.attributes, "ouo.last_events"))).toContain("card=REDACTED");
    expect(attr(captured.spans.find((s) => s.name === "host")!.attributes, "url.full")).toBe("https://x.test/?pw=REDACTED");
    // The app's own requests went out exactly as written.
    expect(captured.requests.map((r) => r.url)).toEqual([`${BACKEND.replace("://", "://bob:hunter2@")}/orders/991?card=4111111111111111&page=2#pay`, `${BACKEND}/orders/5?fail=500&ssn=123-45-6789`]);
  });
});
