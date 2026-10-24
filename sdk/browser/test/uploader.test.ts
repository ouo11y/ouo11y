import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createChunkUploader, replayChunksUrl } from "../src/replay/uploader";
import { basicAuthorization } from "../src/ingest";
import { createLogger } from "../src/logger";
import { Delivery } from "../src/transport/delivery";
import { MemoryStore } from "../src/transport/store";

const AUTH = basicAuthorization("demo", "pt_test_token");

function setup(status = 202) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status }));
  const store = new MemoryStore(1 << 20);
  const delivery = new Delivery({ logger: createLogger(false), store, fetchImpl: fetchImpl as unknown as typeof fetch, drainDelayMs: 60_000 });
  const upload = createChunkUploader({ replayEndpoint: "http://localhost:4319/", authorization: AUTH, logger: createLogger(false), delivery });
  const call = (i = 0) => fetchImpl.mock.calls[i] as [string, RequestInit];
  return { fetchImpl, store, delivery, upload, call };
}

const bigChunk = (seq = 4) => ({
  session_id: "s",
  seq,
  started_at: 1,
  ended_at: 2,
  events: Array.from({ length: 40 }, (_, i) => ({ type: 3, data: { source: 0, texts: [], attributes: [], removes: [], adds: [{ i }] }, timestamp: i })),
});

describe("chunk uploader", () => {
  it("posts gzip JSON with the Basic credential and the ouo headers", async () => {
    const { delivery, upload, call } = setup();
    const chunk = bigChunk();
    await upload(chunk, { keepalive: false });
    const [url, init] = call();
    expect(url).toBe("http://localhost:4319/v1/replay/chunks");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers["x-ouo-session-id"]).toBe("s");
    expect(headers["x-ouo-seq"]).toBe("4");
    expect(headers["Authorization"]).toBe("Basic " + Buffer.from("demo:pt_test_token").toString("base64"));
    expect(headers["X-Ouo-Project-Token"]).toBeUndefined();
    expect(url).not.toContain("pt_test_token");
    expect(JSON.parse(gunzipSync(init.body as Uint8Array).toString("utf8"))).toEqual(chunk);
    expect(delivery.stats.wireBytes).toBeLessThan(delivery.stats.rawBytes);
    delivery.close();
  });

  it("sends plain JSON with keepalive on pagehide, with the credential", async () => {
    const { delivery, upload, call } = setup(204);
    await upload(bigChunk(0), { keepalive: true });
    const init = call()[1];
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)).seq).toBe(0);
    expect((init.headers as Record<string, string>)["content-encoding"]).toBeUndefined();
    // The unload path carries the credential too (ADR-0007: every ingest request is authenticated).
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(AUTH);
    delivery.close();
  });

  it("keeps a chunk that fails at pagehide in the store instead of throwing", async () => {
    const { delivery, store, upload } = setup(500);
    await expect(upload(bigChunk(1), { keepalive: true })).resolves.toBeUndefined();
    expect(store.size()).toBe(1);
    delivery.close();
  });

  it("throws a non-retryable error when the receiver refuses the chunk", async () => {
    const { delivery, upload } = setup(400);
    await expect(upload(bigChunk(2), { keepalive: false })).rejects.toMatchObject({ retryable: false });
    expect(delivery.stats.dropReasons.rejected).toBe(1);
    delivery.close();
  });

  it("builds the chunk URL", () => {
    expect(replayChunksUrl("http://x/")).toBe("http://x/v1/replay/chunks");
  });
});
