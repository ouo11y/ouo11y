import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INGEST_OTLP_PATH, PROJECT_TOKEN_HEADER, REPLAY_CHUNKS_PATH, ingestHeaders, requireProjectToken, resolveEndpoints } from "../src/endpoints";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { MemoryAsyncStorage } from "../src/session/storage";

describe("resolveEndpoints (ADR-0007 section 7)", () => {
  it("derives the OTLP ingest routes and the replay route from the rum-api base URL", () => {
    const e = resolveEndpoints({ endpoint: "https://rum.example.com" });
    expect(e).toEqual({
      rumApi: "https://rum.example.com",
      otlpBase: "https://rum.example.com/ingest/otlp",
      traces: "https://rum.example.com/ingest/otlp/v1/traces",
      logs: "https://rum.example.com/ingest/otlp/v1/logs",
      replayEndpoint: "https://rum.example.com",
      replayChunks: "https://rum.example.com/v1/replay/chunks",
      otlpBypassesRumApi: false,
    });
    expect(INGEST_OTLP_PATH).toBe("/ingest/otlp");
    expect(REPLAY_CHUNKS_PATH).toBe("/v1/replay/chunks");
  });

  it("tolerates trailing slashes and whitespace, keeps a path prefix and a port", () => {
    const e = resolveEndpoints({ endpoint: " http://localhost:8080/// " });
    expect(e.traces).toBe("http://localhost:8080/ingest/otlp/v1/traces");
    expect(e.replayChunks).toBe("http://localhost:8080/v1/replay/chunks");
    const behindPrefix = resolveEndpoints({ endpoint: "https://example.com/ouo/" });
    expect(behindPrefix.logs).toBe("https://example.com/ouo/ingest/otlp/v1/logs");
    expect(behindPrefix.replayChunks).toBe("https://example.com/ouo/v1/replay/chunks");
  });

  it("otlpEndpoint bypasses rum-api for OTLP only; replay stays on rum-api", () => {
    const e = resolveEndpoints({ endpoint: "https://rum.example.com/", otlpEndpoint: "http://otel-collector:4318/" });
    expect(e.otlpBypassesRumApi).toBe(true);
    expect(e.traces).toBe("http://otel-collector:4318/v1/traces");
    expect(e.logs).toBe("http://otel-collector:4318/v1/logs");
    expect(e.replayEndpoint).toBe("https://rum.example.com");
    expect(e.replayChunks).toBe("https://rum.example.com/v1/replay/chunks");
    // An empty override is the same as none.
    expect(resolveEndpoints({ endpoint: "https://rum.example.com", otlpEndpoint: "" }).otlpBypassesRumApi).toBe(false);
  });

  it("rejects a missing endpoint", () => {
    expect(() => resolveEndpoints({ endpoint: "" })).toThrow(/endpoint/);
    expect(() => resolveEndpoints({ endpoint: undefined as unknown as string })).toThrow(/endpoint/);
  });
});

describe("project token", () => {
  it("is required and trimmed", () => {
    expect(requireProjectToken(" pt_live_abc ")).toBe("pt_live_abc");
    for (const bad of [undefined, null, "", "   ", 42, {}]) {
      expect(() => requireProjectToken(bad)).toThrow(/projectToken.*required.*ADR-0007/);
    }
  });

  it("builds the ingest header", () => {
    expect(PROJECT_TOKEN_HEADER).toBe("X-Ouo-Project-Token");
    expect(ingestHeaders("pt_x")).toEqual({ "X-Ouo-Project-Token": "pt_x" });
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

  const base = { endpoint: "http://rum.test:8080", service: { name: "mobile-store", version: "2.3.0", environment: "test" }, storage: new MemoryAsyncStorage() };

  it("throws a clear error when projectToken is missing and installs nothing", () => {
    const before = globalThis.fetch;
    expect(() => initRUM({ ...base } as unknown as Parameters<typeof initRUM>[0])).toThrow(/projectToken.*is required \(ADR-0007\)/);
    expect(() => initRUM({ ...base, projectToken: "" })).toThrow(/projectToken/);
    // Nothing was registered: fetch is still the stub and no instance exists.
    expect(globalThis.fetch).toBe(before);
    expect(getRUM()).toBeUndefined();
  });

  it("throws when endpoint is missing", () => {
    expect(() => initRUM({ ...base, endpoint: "", projectToken: "pt_x" })).toThrow(/endpoint/);
    expect(getRUM()).toBeUndefined();
  });

  it("initialises with a token and reports 0.2.0", async () => {
    const rum = initRUM({ ...base, projectToken: "pt_x" }) as RUMInternal;
    expect(getRUM()).toBe(rum);
    await rum.ready;
  });
});
