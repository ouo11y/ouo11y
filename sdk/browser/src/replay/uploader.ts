import type { ReplayChunk, UploadOptions } from "./chunker";
import { AUTHORIZATION_HEADER, REPLAY_CHUNKS_PATH, trimSlash } from "../ingest";
import type { DebugLogger } from "../logger";

export interface UploaderOptions {
  /** Replay receiver base URL; chunks go to `${replayEndpoint}/v1/replay/chunks`. */
  replayEndpoint: string;
  /** `Authorization` header value (`Basic ...`), sent on every upload including the keepalive unload path (ADR-0007). */
  authorization: string;
  logger: DebugLogger;
  fetchImpl?: typeof fetch;
}

export { REPLAY_CHUNKS_PATH };

export function replayChunksUrl(replayEndpoint: string): string {
  return `${trimSlash(replayEndpoint)}${REPLAY_CHUNKS_PATH}`;
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
  const url = replayChunksUrl(options.replayEndpoint);
  return async (chunk, upload) => {
    const json = JSON.stringify(chunk);
    // The credential rides on both paths (regular and pagehide keepalive): same function, same headers.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [AUTHORIZATION_HEADER]: options.authorization,
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
