import type { ReplayChunk, UploadOptions } from "./chunker";
import { AUTHORIZATION_HEADER, REPLAY_CHUNKS_PATH, trimSlash } from "../ingest";
import type { DebugLogger } from "../logger";
import type { Delivery } from "../transport/delivery";

export interface UploaderOptions {
  /** Replay receiver base URL; chunks go to `${replayEndpoint}/v1/replay/chunks`. */
  replayEndpoint: string;
  /** `Authorization` header value (`Basic ...`), sent on every upload including the unload path (ADR-0007). */
  authorization: string;
  logger: DebugLogger;
  /** gzip, retry, keepalive and the offline store, shared with the OTLP exporters. */
  delivery: Delivery;
}

export { REPLAY_CHUNKS_PATH };
export { canGzip } from "../transport/gzip";

export function replayChunksUrl(replayEndpoint: string): string {
  return `${trimSlash(replayEndpoint)}${REPLAY_CHUNKS_PATH}`;
}

/** The receiver refused the chunk (any answer but 2xx, 429, 502, 503 and 504): sending it again cannot help. */
export class ChunkRejectedError extends Error {
  readonly retryable = false;
}

/**
 * Upload function for the {@link ReplayChunker}. Resolves once the chunk is sent, being retried,
 * or kept in the offline store; rejects only when the receiver refused it.
 */
export function createChunkUploader(options: UploaderOptions): (chunk: ReplayChunk, upload: UploadOptions) => Promise<void> {
  const url = replayChunksUrl(options.replayEndpoint);
  return async (chunk, upload) => {
    const body = new TextEncoder().encode(JSON.stringify(chunk));
    // The credential rides on every path (regular, unload, stored): it is part of the request.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [AUTHORIZATION_HEADER]: options.authorization,
      "x-ouo-session-id": chunk.session_id,
      "x-ouo-seq": String(chunk.seq),
    };
    options.logger.log(`replay: chunk seq=${chunk.seq} ${body.byteLength} B${upload.keepalive ? " at page hide" : ""}`);
    const outcome = await options.delivery.send({ url, headers, body, label: "replay" }, { urgent: upload.keepalive });
    if (outcome === "dropped") throw new ChunkRejectedError(`replay chunk seq=${chunk.seq} refused by the receiver`);
  };
}
