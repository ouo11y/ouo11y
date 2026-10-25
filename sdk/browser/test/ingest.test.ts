import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHORIZATION_HEADER, base64Utf8, basicAuthorization, deriveIngestUrls, deriveReplayEndpoint, ingestHeaders } from "../src/ingest";
import { initRUM } from "../src/index";

const CRED = { projectId: "demo", projectToken: "pt_dev_demo_0000000000000000" };

describe("Basic credential (ADR-0007 sections 2 and 6)", () => {
  it("builds `Basic base64(projectId:projectToken)`", () => {
    const value = basicAuthorization("demo", "pt_dev_demo_0000000000000000");
    expect(value).toBe("Basic " + Buffer.from("demo:pt_dev_demo_0000000000000000", "utf8").toString("base64"));
    expect(value).toBe("Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw");
    expect(ingestHeaders(value)).toEqual({ Authorization: value });
    expect(AUTHORIZATION_HEADER).toBe("Authorization");
  });

  it("is UTF-8 safe (btoa alone throws above U+00FF and emits Latin-1 bytes below it)", () => {
    expect(() => btoa("web-st€re:pt")).toThrow(); // U+20AC
    expect(base64Utf8("web-st€re:pt")).toBe(Buffer.from("web-st€re:pt", "utf8").toString("base64"));
    // U+00F6 does not throw in btoa but encodes as one Latin-1 byte; the server decodes UTF-8.
    expect(btoa("web-störe:pt")).not.toBe(Buffer.from("web-störe:pt", "utf8").toString("base64"));
    expect(base64Utf8("web-störe:pt")).toBe(Buffer.from("web-störe:pt", "utf8").toString("base64"));
    expect(basicAuthorization("web-störe", "pt_€")).toBe("Basic " + Buffer.from("web-störe:pt_€", "utf8").toString("base64"));
  });

  it("trims surrounding whitespace and rejects a colon in the id", () => {
    expect(basicAuthorization(" demo ", " pt ")).toBe("Basic " + Buffer.from("demo:pt").toString("base64"));
    expect(() => basicAuthorization("a:b", "pt")).toThrow(/projectId.*:/);
  });

  it("rejects a missing or empty id or token with an actionable message", () => {
    expect(() => basicAuthorization("", "pt")).toThrow(/projectId.*required/);
    expect(() => basicAuthorization("   ", "pt")).toThrow(/projectId/);
    expect(() => basicAuthorization(undefined as unknown as string, "pt")).toThrow(/projectId/);
    expect(() => basicAuthorization("demo", "")).toThrow(/projectToken.*required/);
    expect(() => basicAuthorization("demo", "   ")).toThrow(/projectToken/);
    expect(() => basicAuthorization("demo", undefined as unknown as string)).toThrow(/projectToken/);
    expect(() => deriveIngestUrls({ endpoint: "http://localhost:4318", projectId: "", projectToken: "pt" })).toThrow(/projectId/);
    expect(() => deriveIngestUrls({ endpoint: "http://localhost:4318", projectId: "demo", projectToken: "" })).toThrow(/projectToken/);
    expect(() => deriveIngestUrls({ endpoint: "", ...CRED })).toThrow(/endpoint.*required/);
  });
});

describe("ingest URL derivation (ADR-0007 section 6)", () => {
  it("port 4318 endpoint: OTLP on 4318, replay on 4319, same scheme and host", () => {
    const u = deriveIngestUrls({ endpoint: "http://localhost:4318/", ...CRED });
    expect(u).toEqual({
      endpoint: "http://localhost:4318",
      replayEndpoint: "http://localhost:4319",
      traces: "http://localhost:4318/v1/traces",
      logs: "http://localhost:4318/v1/logs",
      replay: "http://localhost:4319/v1/replay/chunks",
    });
    expect(deriveReplayEndpoint("https://otel.example.com:4318/base/")).toBe("https://otel.example.com:4319/base");
    expect(deriveReplayEndpoint("http://[::1]:4318")).toBe("http://[::1]:4319");
  });

  it("non-4318 endpoint: replay shares the endpoint (a proxy routes /v1/replay/*)", () => {
    const u = deriveIngestUrls({ endpoint: "https://otel.example.com///", ...CRED });
    expect(u.endpoint).toBe("https://otel.example.com");
    expect(u.replayEndpoint).toBe("https://otel.example.com");
    expect(u.traces).toBe("https://otel.example.com/v1/traces");
    expect(u.logs).toBe("https://otel.example.com/v1/logs");
    expect(u.replay).toBe("https://otel.example.com/v1/replay/chunks");
    expect(deriveReplayEndpoint("http://localhost:8090")).toBe("http://localhost:8090");
    expect(deriveReplayEndpoint("http://localhost:43180")).toBe("http://localhost:43180");
  });

  it("a relative endpoint (a first-party proxy route) resolves against the page origin, replay included", () => {
    const u = deriveIngestUrls({ endpoint: "/otel/", ...CRED });
    expect(u.endpoint).toBe(`${location.origin}/otel`);
    expect(u.traces).toBe(`${location.origin}/otel/v1/traces`);
    expect(u.replay).toBe(`${location.origin}/otel/v1/replay/chunks`);
    expect(deriveIngestUrls({ endpoint: "/otel", replayEndpoint: "/replay", ...CRED }).replay).toBe(`${location.origin}/replay/v1/replay/chunks`);
  });

  it("explicit replayEndpoint wins, whatever the endpoint port", () => {
    const u = deriveIngestUrls({ endpoint: "http://localhost:4318", replayEndpoint: "https://replay.example.com/", ...CRED });
    expect(u.replayEndpoint).toBe("https://replay.example.com");
    expect(u.replay).toBe("https://replay.example.com/v1/replay/chunks");
    expect(u.traces).toBe("http://localhost:4318/v1/traces");
  });

  it("a blank replayEndpoint is treated as absent", () => {
    const u = deriveIngestUrls({ endpoint: "http://localhost:4318", replayEndpoint: "  ", ...CRED });
    expect(u.replayEndpoint).toBe("http://localhost:4319");
  });

  it("never puts the id or token in a URL, only in the header", () => {
    const u = deriveIngestUrls({ endpoint: "http://localhost:4318", projectId: "proj_x", projectToken: "pt_secret_looking" });
    for (const v of Object.values(u)) {
      expect(v).not.toContain("pt_secret_looking");
      expect(v).not.toContain("proj_x");
    }
  });
});

describe("initRUM credential validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws before installing anything when projectId or projectToken is missing", () => {
    const addSpy = vi.spyOn(globalThis, "addEventListener");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = { name: "t", version: "1", environment: "test" };
    type Opts = Parameters<typeof initRUM>[0];
    expect(() => initRUM({ endpoint: "http://localhost:4318", projectToken: "pt", service } as unknown as Opts)).toThrow(/projectId/);
    expect(() => initRUM({ endpoint: "http://localhost:4318", projectId: "demo", service } as unknown as Opts)).toThrow(/projectToken/);
    expect(() => initRUM({ endpoint: "http://localhost:4318", projectId: "", projectToken: "pt", service })).toThrow(/projectId/);
    expect(() => initRUM({ endpoint: "http://localhost:4318", projectId: "demo", projectToken: "", service })).toThrow(/projectToken/);
    // No listeners were registered and no "called twice" warning: the throw happened before `instance` was set.
    expect(addSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(localStorage.getItem("ouo.session")).toBeNull();
  });
});
