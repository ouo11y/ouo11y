import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORIZATION_HEADER,
  DEFAULT_OTLP_PORT,
  DEFAULT_REPLAY_PORT,
  REPLAY_CHUNKS_PATH,
  base64Encode,
  basicAuthorization,
  defaultReplayEndpoint,
  ingestHeaders,
  requireCredentials,
  resolveEndpoints,
} from "../src/endpoints";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { MemoryAsyncStorage } from "../src/session/storage";

describe("resolveEndpoints (ADR-0007 section 6)", () => {
  it("derives the OTLP routes and the replay route from the collector base URL", () => {
    const e = resolveEndpoints({ endpoint: "https://otel.example.com" });
    expect(e).toEqual({
      endpoint: "https://otel.example.com",
      traces: "https://otel.example.com/v1/traces",
      logs: "https://otel.example.com/v1/logs",
      // No port 4318: a proxy host routes /v1/replay/* itself, so replay goes to the same base.
      replayEndpoint: "https://otel.example.com",
      replayChunks: "https://otel.example.com/v1/replay/chunks",
      replayEndpointDerived: true,
    });
    expect(REPLAY_CHUNKS_PATH).toBe("/v1/replay/chunks");
    expect(DEFAULT_OTLP_PORT).toBe(4318);
    expect(DEFAULT_REPLAY_PORT).toBe(4319);
  });

  it("maps port 4318 to the replay receiver's 4319 (host names, IPv4, IPv6, trailing slash, path prefix)", () => {
    expect(defaultReplayEndpoint("http://localhost:4318")).toBe("http://localhost:4319");
    expect(defaultReplayEndpoint("http://192.168.1.23:4318/")).toBe("http://192.168.1.23:4319");
    expect(defaultReplayEndpoint("http://[::1]:4318")).toBe("http://[::1]:4319");
    expect(defaultReplayEndpoint("https://otel.example.com:4318/prefix/")).toBe("https://otel.example.com:4319/prefix");
    // Any other port, or none, is used as is.
    expect(defaultReplayEndpoint("http://localhost:4328")).toBe("http://localhost:4328");
    expect(defaultReplayEndpoint("http://localhost:43180")).toBe("http://localhost:43180");
    expect(defaultReplayEndpoint("https://otel.example.com/")).toBe("https://otel.example.com");
    // Only the authority's port counts, never a `4318` in the path.
    expect(defaultReplayEndpoint("https://otel.example.com/4318")).toBe("https://otel.example.com/4318");

    const e = resolveEndpoints({ endpoint: " http://localhost:4318/// " });
    expect(e.traces).toBe("http://localhost:4318/v1/traces");
    expect(e.logs).toBe("http://localhost:4318/v1/logs");
    expect(e.replayEndpoint).toBe("http://localhost:4319");
    expect(e.replayChunks).toBe("http://localhost:4319/v1/replay/chunks");
    expect(e.replayEndpointDerived).toBe(true);
  });

  it("an explicit replayEndpoint wins and is normalised", () => {
    const e = resolveEndpoints({ endpoint: "http://localhost:4318", replayEndpoint: " https://replay.example.com/ " });
    expect(e.replayEndpoint).toBe("https://replay.example.com");
    expect(e.replayChunks).toBe("https://replay.example.com/v1/replay/chunks");
    expect(e.replayEndpointDerived).toBe(false);
    // An empty override is the same as none.
    expect(resolveEndpoints({ endpoint: "http://localhost:4318", replayEndpoint: "" }).replayEndpoint).toBe("http://localhost:4319");
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

  it("throws a clear error when projectId or projectToken is missing and installs nothing", () => {
    const before = globalThis.fetch;
    expect(() => initRUM({ ...base, projectToken: "pt_x" } as unknown as Options)).toThrow(/projectId.*is required \(ADR-0007\)/);
    expect(() => initRUM({ ...base, projectId: "demo" } as unknown as Options)).toThrow(/projectToken.*is required \(ADR-0007\)/);
    expect(() => initRUM({ ...base, projectId: "", projectToken: "pt_x" })).toThrow(/projectId/);
    expect(() => initRUM({ ...base, projectId: "demo", projectToken: "" })).toThrow(/projectToken/);
    // Nothing was registered: fetch is still the stub and no instance exists.
    expect(globalThis.fetch).toBe(before);
    expect(getRUM()).toBeUndefined();
  });

  it("throws when endpoint is missing", () => {
    expect(() => initRUM({ ...base, endpoint: "", projectId: "demo", projectToken: "pt_x" })).toThrow(/endpoint/);
    expect(getRUM()).toBeUndefined();
  });

  it("initialises with a credential", async () => {
    const rum = initRUM({ ...base, projectId: "demo", projectToken: "pt_x" }) as RUMInternal;
    expect(getRUM()).toBe(rum);
    await rum.ready;
  });
});
