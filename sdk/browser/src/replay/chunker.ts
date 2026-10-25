import type { Clock } from "../session/clock";
import { systemClock } from "../session/clock";
import type { DebugLogger } from "../logger";

/** Chunk format (ADR-0003). `started_at` / `ended_at` are Unix epoch milliseconds. */
export interface ReplayChunk {
  session_id: string;
  seq: number;
  started_at: number;
  ended_at: number;
  events: unknown[];
}

export interface UploadOptions {
  /** Page is unloading: send synchronously with `keepalive`, no compression, no retry. */
  keepalive: boolean;
}

export interface ChunkerOptions {
  /** Active session id; captured when a buffer starts so a rotation does not relabel buffered events. */
  sessionId: () => string;
  /** Reserves the next sequence number for the active session. */
  nextSeq: () => number;
  upload: (chunk: ReplayChunk, options: UploadOptions) => Promise<void>;
  clock?: Clock;
  /** Default 5000 ms. */
  flushIntervalMs?: number;
  /** Default 256 KB. */
  maxChunkBytes?: number;
  /** Upper bound on buffered + queued bytes. Default 2 MB. */
  maxBufferBytes?: number;
  /** Upload attempts per chunk. Default 3. */
  maxAttempts?: number;
  logger?: DebugLogger;
}

interface Pending {
  chunk: ReplayChunk;
  bytes: number;
  attempts: number;
}

interface RrwebLikeEvent {
  timestamp?: number;
}

export const DEFAULT_FLUSH_INTERVAL_MS = 5000;
export const DEFAULT_MAX_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/**
 * Buffers rrweb events and cuts chunks every `flushIntervalMs` or when the buffer
 * reaches `maxChunkBytes`, whichever comes first. Uploads sequentially with retry.
 */
export class ReplayChunker {
  private readonly sessionId: () => string;
  private readonly nextSeq: () => number;
  private readonly upload: (chunk: ReplayChunk, options: UploadOptions) => Promise<void>;
  private readonly clock: Clock;
  private readonly flushIntervalMs: number;
  private readonly maxChunkBytes: number;
  private readonly maxBufferBytes: number;
  private readonly maxAttempts: number;
  private readonly logger: DebugLogger | undefined;

  private buffer: unknown[] = [];
  private bufferBytes = 0;
  private bufferSessionId: string | null = null;
  private bufferSeq = 0;
  private bufferStartedAt = 0;
  private timer: unknown = null;

  private queue: Pending[] = [];
  private queuedBytes = 0;
  private sending: Promise<void> | null = null;
  private retryTimer: unknown = null;

  constructor(options: ChunkerOptions) {
    this.sessionId = options.sessionId;
    this.nextSeq = options.nextSeq;
    this.upload = options.upload;
    this.clock = options.clock ?? systemClock;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.logger = options.logger;
  }

  push(event: unknown): void {
    const bytes = estimateBytes(event);
    if (this.buffer.length === 0) {
      this.bufferSessionId = this.sessionId();
      this.bufferSeq = this.nextSeq();
      this.bufferStartedAt = (event as RrwebLikeEvent).timestamp ?? this.clock.now();
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushIntervalMs);
    }
    this.buffer.push(event);
    this.bufferBytes += bytes;
    this.enforceBound();
    if (this.bufferBytes >= this.maxChunkBytes) void this.flush();
  }

  /** Cuts the buffer into a chunk (pure, no upload). Returns null when empty. */
  cut(): ReplayChunk | null {
    if (this.buffer.length === 0 || this.bufferSessionId === null) return null;
    const last = this.buffer[this.buffer.length - 1] as RrwebLikeEvent;
    const chunk: ReplayChunk = {
      session_id: this.bufferSessionId,
      seq: this.bufferSeq,
      started_at: this.bufferStartedAt,
      ended_at: last.timestamp ?? this.clock.now(),
      events: this.buffer,
    };
    this.buffer = [];
    this.bufferBytes = 0;
    this.bufferSessionId = null;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    return chunk;
  }

  /** Cuts the current buffer and drains the upload queue. */
  async flush(options: Partial<UploadOptions> = {}): Promise<void> {
    const keepalive = options.keepalive ?? false;
    const chunk = this.cut();
    if (chunk) this.enqueue(chunk);
    if (keepalive) {
      // Page is going away: fire every queued chunk now, no ordering guarantees, no retries.
      const pending = this.queue;
      this.queue = [];
      this.queuedBytes = 0;
      for (const p of pending) void this.upload(p.chunk, { keepalive: true }).catch(() => undefined);
      return;
    }
    await this.drain();
  }

  pendingBytes(): number {
    return this.bufferBytes + this.queuedBytes;
  }

  bufferedEvents(): number {
    return this.buffer.length;
  }

  queuedChunks(): number {
    return this.queue.length;
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  // ---- internals ----

  private enqueue(chunk: ReplayChunk): void {
    const bytes = estimateBytes(chunk.events);
    this.queue.push({ chunk, bytes, attempts: 0 });
    this.queuedBytes += bytes;
    this.enforceBound();
  }

  private enforceBound(): void {
    while (this.pendingBytes() > this.maxBufferBytes && this.queue.length > 0) {
      const dropped = this.queue.shift()!;
      this.queuedBytes -= dropped.bytes;
      this.logger?.warn("replay: dropped queued chunk (buffer bound)", dropped.chunk.session_id, dropped.chunk.seq);
    }
    if (this.pendingBytes() > this.maxBufferBytes && this.buffer.length > 0) {
      this.logger?.warn("replay: dropped buffered events (buffer bound)", this.buffer.length);
      this.cut();
    }
  }

  private drain(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.sendLoop().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async sendLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      try {
        await this.upload(head.chunk, { keepalive: false });
        this.queue.shift();
        this.queuedBytes -= head.bytes;
        this.logger?.log("replay: uploaded chunk", head.chunk.session_id, head.chunk.seq, `${head.chunk.events.length} events`);
      } catch (err) {
        head.attempts += 1;
        // The delivery layer already retried, stored or refused it: a refusal is final.
        if (head.attempts >= this.maxAttempts || (err as { retryable?: boolean } | null)?.retryable === false) {
          this.queue.shift();
          this.queuedBytes -= head.bytes;
          this.logger?.warn("replay: giving up on chunk", head.chunk.seq, err);
          continue;
        }
        const delay = 1000 * 2 ** (head.attempts - 1);
        this.logger?.warn(`replay: upload failed, retry in ${delay} ms`, head.chunk.seq, err);
        await new Promise<void>((resolve) => {
          this.retryTimer = this.clock.setTimeout(() => {
            this.retryTimer = null;
            resolve();
          }, delay);
        });
      }
    }
  }
}

/** Cheap byte estimate: UTF-16 length of the JSON, good enough for chunk sizing. */
export function estimateBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
