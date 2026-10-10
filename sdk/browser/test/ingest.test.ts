import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveIngestUrls, PROJECT_TOKEN_HEADER, projectTokenHeaders } from "../src/ingest";
import { initRUM } from "../src/index";

describe("ingest URL derivation (ADR-0007 section 7)", () => {
  it("routes OTLP through rum-api and replay to rum-api by default", () => {
    const u = deriveIngestUrls({ endpoint: "https://rum.example.com/", projectToken: "pt_live_x" });
    expect(u).toEqual({
      endpoint: "https://rum.example.com",
      otlpBase: "https://rum.example.com/ingest/otlp",
      traces: "https://rum.example.com/ingest/otlp/v1/traces",
      logs: "https://rum.example.com/ingest/otlp/v1/logs",
      replay: "https://rum.example.com/v1/replay/chunks",
      otlpBypass: false,
    });
  });

  it("otlpEndpoint bypasses rum-api for OTLP only; replay stays on rum-api", () => {
    const u = deriveIngestUrls({ endpoint: "http://localhost:8080", projectToken: "pt_dev", otlpEndpoint: "http://otel-collector:4318///" });
    expect(u.traces).toBe("http://otel-collector:4318/v1/traces");
    expect(u.logs).toBe("http://otel-collector:4318/v1/logs");
    expect(u.otlpBase).toBe("http://otel-collector:4318");
    expect(u.replay).toBe("http://localhost:8080/v1/replay/chunks");
    expect(u.otlpBypass).toBe(true);
  });

  it("an empty otlpEndpoint is treated as absent", () => {
    const u = deriveIngestUrls({ endpoint: "http://localhost:8080", projectToken: "pt_dev", otlpEndpoint: "  " });
    expect(u.otlpBypass).toBe(false);
    expect(u.traces).toBe("http://localhost:8080/ingest/otlp/v1/traces");
  });

  it("rejects a missing or empty token with an actionable message", () => {
    expect(() => deriveIngestUrls({ endpoint: "http://localhost:8080", projectToken: "" })).toThrow(/projectToken.*required/);
    expect(() => deriveIngestUrls({ endpoint: "http://localhost:8080", projectToken: "   " })).toThrow(/projectToken/);
    expect(() => deriveIngestUrls({ endpoint: "http://localhost:8080", projectToken: undefined as unknown as string })).toThrow(/projectToken/);
    expect(() => deriveIngestUrls({ endpoint: "", projectToken: "pt" })).toThrow(/endpoint.*required/);
  });

  it("never puts the token in a URL, only in the header", () => {
    const u = deriveIngestUrls({ endpoint: "http://localhost:8080", projectToken: "pt_secret_looking" });
    for (const v of Object.values(u)) if (typeof v === "string") expect(v).not.toContain("pt_secret_looking");
    expect(projectTokenHeaders("pt_secret_looking")).toEqual({ [PROJECT_TOKEN_HEADER]: "pt_secret_looking" });
    expect(PROJECT_TOKEN_HEADER).toBe("X-Ouo-Project-Token");
  });
});

describe("initRUM token validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws before installing anything when projectToken is missing", () => {
    const addSpy = vi.spyOn(globalThis, "addEventListener");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = { name: "t", version: "1", environment: "test" };
    expect(() => initRUM({ endpoint: "http://localhost:8080", service } as unknown as Parameters<typeof initRUM>[0])).toThrow(/projectToken/);
    expect(() => initRUM({ endpoint: "http://localhost:8080", projectToken: "", service })).toThrow(/projectToken/);
    // No listeners were registered and no "called twice" warning: the throw happened before `instance` was set.
    expect(addSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(localStorage.getItem("ouo.session")).toBeNull();
  });
});
