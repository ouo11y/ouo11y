import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createChunkUploader, replayChunksUrl } from "../src/replay/uploader";
import { basicAuthorization } from "../src/ingest";
import { createLogger } from "../src/logger";

const AUTH = basicAuthorization("demo", "pt_test_token");

describe("chunk uploader", () => {
  it("posts gzip JSON with the Basic credential and the ouo headers", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      void init;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const upload = createChunkUploader({ replayEndpoint: "http://localhost:4319/", authorization: AUTH, logger: createLogger(false), fetchImpl });
    const chunk = { session_id: "s", seq: 4, started_at: 1, ended_at: 2, events: [{ type: 2, data: {}, timestamp: 1 }] };
    await upload(chunk, { keepalive: false });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("http://localhost:4319/v1/replay/chunks");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers["x-ouo-session-id"]).toBe("s");
    expect(headers["x-ouo-seq"]).toBe("4");
    expect(headers["Authorization"]).toBe("Basic " + Buffer.from("demo:pt_test_token").toString("base64"));
    expect(headers["X-Ouo-Project-Token"]).toBeUndefined();
    expect(url).not.toContain("pt_test_token");
    const decoded = JSON.parse(gunzipSync(Buffer.from(init.body as ArrayBuffer)).toString("utf8"));
    expect(decoded).toEqual(chunk);
  });

  it("sends plain JSON with keepalive on pagehide", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const upload = createChunkUploader({ replayEndpoint: "http://localhost:4319", authorization: AUTH, logger: createLogger(false), fetchImpl });
    await upload({ session_id: "s", seq: 0, started_at: 1, ended_at: 2, events: [] }, { keepalive: true });
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(init.keepalive).toBe(true);
    expect(typeof init.body).toBe("string");
    expect((init.headers as Record<string, string>)["content-encoding"]).toBeUndefined();
    // The unload path carries the credential too (ADR-0007: every ingest request is authenticated).
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(AUTH);
    expect((init.headers as Record<string, string>)["X-Ouo-Project-Token"]).toBeUndefined();
  });

  it("throws on non-2xx so the chunker retries", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const upload = createChunkUploader({ replayEndpoint: "http://localhost:4319", authorization: AUTH, logger: createLogger(false), fetchImpl });
    await expect(upload({ session_id: "s", seq: 0, started_at: 1, ended_at: 2, events: [] }, { keepalive: true })).rejects.toThrow("HTTP 500");
  });

  it("builds the chunk URL", () => {
    expect(replayChunksUrl("http://x/")).toBe("http://x/v1/replay/chunks");
  });
});
