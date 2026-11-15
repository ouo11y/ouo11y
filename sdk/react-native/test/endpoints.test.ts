import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORIZATION_HEADER,
  DEFAULT_OTLP_PORT,
  base64Encode,
  basicAuthorization,
  ingestHeaders,
  requireCredentials,
  resolveEndpoints,
} from "../src/endpoints";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { MemoryAsyncStorage } from "../src/session/storage";

describe("resolveEndpoints (ADR-0007 section 6)", () => {
  // Replay chunks are OTLP log records now (ADR-0021 decision 5): there is no separate replay
  // endpoint.
  it("derives the OTLP routes from the collector base URL; replay chunks use the logs route", () => {
    expect(resolveEndpoints({ endpoint: "https://otel.example.com" })).toEqual({
      endpoint: "https://otel.example.com",
      traces: "https://otel.example.com/v1/traces",
      logs: "https://otel.example.com/v1/logs",
    });
    expect(DEFAULT_OTLP_PORT).toBe(4318);
    const e = resolveEndpoints({ endpoint: " http://localhost:4318/// " });
    expect(e.traces).toBe("http://localhost:4318/v1/traces");
    expect(e.logs).toBe("http://localhost:4318/v1/logs");
  });

  it("rejects a missing endpoint", () => {
    expect(() => resolveEndpoints({ endpoint: "" })).toThrow(/endpoint/);
    expect(() => resolveEndpoints({ endpoint: undefined as unknown as string })).toThrow(/endpoint.*collector/);
  });
});

describe("project credential (HTTP Basic, ADR-0007 section 2)", () => {
  it("base64 encodes UTF-8 with padding like Buffer / btoa", () => {
    expect(base64Encode("")).toBe("");
    expect(base64Encode("f")).toBe("Zg==");
    expect(base64Encode("fo")).toBe("Zm8=");
    expect(base64Encode("foo")).toBe("Zm9v");
    expect(base64Encode("demo:pt_dev_demo_0000000000000000")).toBe("ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw");
    expect(base64Encode("pröjekt:tökén✓🙂")).toBe(Buffer.from("pröjekt:tökén✓🙂").toString("base64"));
    expect(base64Encode("pröjekt:tökén✓🙂")).toBe("cHLDtmpla3Q6dMO2a8OpbuKck/CfmYI=");
  });

  it("builds the Authorization header value and the exporter headers", () => {
    expect(AUTHORIZATION_HEADER).toBe("Authorization");
    expect(basicAuthorization("demo", "pt_dev_demo_0000000000000000")).toBe("Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw");
    expect(basicAuthorization("web-store", "pt_live_9f3c")).toBe("Basic d2ViLXN0b3JlOnB0X2xpdmVfOWYzYw==");
    expect(ingestHeaders("Basic abc")).toEqual({ Authorization: "Basic abc" });
    // Never the revision-1 header.
    expect(Object.keys(ingestHeaders("Basic abc"))).not.toContain("X-Ouo-Project-Token");
  });

  it("requires and trims both ids, rejects a colon in the project id", () => {
    expect(requireCredentials({ projectId: " demo ", projectToken: " pt_live_abc " })).toEqual({ projectId: "demo", projectToken: "pt_live_abc" });
    for (const bad of [undefined, null, "", "   ", 42, {}]) {
      expect(() => requireCredentials({ projectId: bad, projectToken: "pt_x" })).toThrow(/projectId.*required.*ADR-0007/);
      expect(() => requireCredentials({ projectId: "demo", projectToken: bad })).toThrow(/projectToken.*required.*ADR-0007/);
    }
    expect(() => requireCredentials({ projectId: "a:b", projectToken: "pt_x" })).toThrow(/projectId.*":"/);
    // A colon in the token is fine: Basic splits on the first one only.
    expect(requireCredentials({ projectId: "demo", projectToken: "pt:x" }).projectToken).toBe("pt:x");
  });
});

describe("initRUM configuration errors", () => {
  const g = globalThis as { __ouoSessionProcessState?: unknown };
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    delete g.__ouoSessionProcessState;
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete g.__ouoSessionProcessState;
  });

  const base = { endpoint: "http://otel.test:4318", service: { name: "mobile-store", version: "2.3.0", environment: "test" }, storage: new MemoryAsyncStorage() };
  type Options = Parameters<typeof initRUM>[0];

  // Spec CFG-1 (ADR-0021 step A): invalid configuration no longer throws; the SDK is a no-op.
  it("is a no-op that installs nothing when projectId or projectToken is missing", () => {
    const before = globalThis.fetch;
    for (const bad of [
      { ...base, projectToken: "pt_x" },
      { ...base, projectId: "demo" },
      { ...base, projectId: "", projectToken: "pt_x" },
      { ...base, projectId: "demo", projectToken: "" },
      { ...base, projectId: "a:b", projectToken: "pt_x" },
    ]) {
      const rum = initRUM(bad as unknown as Options);
      expect(rum.getSessionId()).toBeUndefined();
      expect(() => rum.recordEvent("x")).not.toThrow();
    }
    // Nothing was registered: fetch is still the stub and no instance exists.
    expect(globalThis.fetch).toBe(before);
    expect(getRUM()).toBeUndefined();
  });

  it("is a no-op when endpoint is missing or not a URL", () => {
    for (const endpoint of ["", "otel.example.com", undefined, 42]) {
      const rum = initRUM({ ...base, endpoint, projectId: "demo", projectToken: "pt_x" } as unknown as Options);
      expect(rum.getSessionId()).toBeUndefined();
    }
    expect(getRUM()).toBeUndefined();
  });

  it("initialises with a credential", async () => {
    const rum = initRUM({ ...base, projectId: "demo", projectToken: "pt_x" }) as RUMInternal;
    expect(getRUM()).toBe(rum);
    await rum.ready;
  });
});
