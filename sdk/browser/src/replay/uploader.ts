import type { ReplayChunk, UploadOptions } from "./chunker";
import type { DebugLogger } from "../logger";

export interface UploaderOptions {
  /** rum-api base URL; chunks go to `${endpoint}/v1/replay/chunks`. */
  endpoint: string;
  logger: DebugLogger;
  fetchImpl?: typeof fetch;
}

export const REPLAY_CHUNKS_PATH = "/v1/replay/chunks";

export function replayChunksUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}${REPLAY_CHUNKS_PATH}`;
}

export function canGzip(): boolean {
  return typeof CompressionStream === "function";
}

/** gzip a string with the platform CompressionStream. */
export async function gzip(text: string): Promise<ArrayBuffer> {
  // Response bodies are streams everywhere (browsers, Node, jsdom); Blob.stream() is not.
  const source = new Response(new TextEncoder().encode(text)).body;
  if (!source) throw new Error("no body stream");
  return new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

/** fetch that bypasses the OTel fetch instrumentation wrapper so chunk uploads do not become spans. */
function rawFetch(): typeof fetch {
  const f = globalThis.fetch as typeof fetch & { __original?: typeof fetch };
  return typeof f.__original === "function" ? f.__original : f;
}

export function createChunkUploader(options: UploaderOptions): (chunk: ReplayChunk, upload: UploadOptions) => Promise<void> {
  const url = replayChunksUrl(options.endpoint);
  return async (chunk, upload) => {
    const json = JSON.stringify(chunk);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-ouo-session-id": chunk.session_id,
      "x-ouo-seq": String(chunk.seq),
    };
    let body: BodyInit = json;
    // Compression is async; during pagehide we cannot await it, so send plain JSON with keepalive.
    if (!upload.keepalive && canGzip()) {
      body = await gzip(json);
      headers["content-encoding"] = "gzip";
    }
    const fetchImpl = options.fetchImpl ?? rawFetch();
    const bytes = typeof body === "string" ? body.length : (body as ArrayBuffer).byteLength;
    options.logger.log(`replay: POST seq=${chunk.seq} ${bytes} bytes${headers["content-encoding"] ? " gzip" : ""}${upload.keepalive ? " keepalive" : ""}`);
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      keepalive: upload.keepalive || bytes < 48 * 1024,
      mode: "cors",
    });
    if (!res.ok) throw new Error(`replay chunk upload failed: HTTP ${res.status}`);
  };
}
