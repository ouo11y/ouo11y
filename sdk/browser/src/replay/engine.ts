/**
 * The replay engine (SDK spec section 11), loaded on demand so the core bundle does not carry it.
 *
 * It owns everything that does not depend on the format: one stream per page lifetime (RPL-5),
 * segments that start at a keyframe (RPL-6), chunks numbered from 0 with no gap (RPL-4) and
 * bounded in time and size (RPL-10, RPL-11), the SHA-256 of every body (RPL-12), the buffer ring
 * (SMP-10 to SMP-12), persistence before the first send (RPL-15), one request per chunk in
 * sequence order on a queue of its own (TRN-3, TRN-5, RPL-16), the end record (RPL-20) and the
 * recovery of streams an earlier page left behind (TRN-18, TRN-19).
 *
 * A chunk is an OpenTelemetry log record: event `ouo.replay.chunk` on scope `ouo.replay`, the
 * body as bytes, sent as OTLP/HTTP protobuf (RPL-2, TRN-1). The record is made through the Logs
 * API of the SDK's logger provider and handed back here by its processor.
 */
import type { AnyValue } from "@opentelemetry/api-logs";
import { ProtobufLogsSerializer } from "@opentelemetry/otlp-transformer/build/esm/logs/protobuf";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { CHUNK_HARD_LIMIT } from "../config";
import type { Clock, TimerHandle } from "../core/clock";
import type { DropCounter } from "../core/drops";
import { randomHex } from "../core/ids";
import { attempt, point, quiet } from "../guard";
import type { DebugLogger } from "../logger";
import { canGzip, gzipBytes } from "../transport/gzip";
import type { Http } from "../transport/http";
import { retryDelay } from "../transport/retry";
import type { Outbox, OutboxEntry, OutboxMeta, StreamRow } from "../transport/store";
import type { AdapterSink, ReplayAdapter } from "./adapter";
import { sha256, sha256Sync } from "./sha256";

export const PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
/** Chunk bytes that may wait to be sent before whole segments are dropped (RPL-17). */
export const BACKLOG_MAX_BYTES = 4 * 1024 * 1024;
/** Bytes the buffer ring may hold. */
export const RING_MAX_BYTES = 8 * 1024 * 1024;

export type EndReason = "session_end" | "stop" | "consent" | "pagehide" | "background_kill" | "crash" | "max_size" | "error";
export type Trigger = "error" | "manual";

export interface EngineDeps {
  adapter: ReplayAdapter;
  mode: "session" | "buffer";
  replayId: string;
  sessionId: string;
  viewId(): string | undefined;
  /** Makes one `ouo.replay` record through the Logs API (the pipeline's factory). */
  makeRecord(name: string, attributes: Record<string, AnyValue>, time: number, observed: number, body?: Uint8Array): ReadableLogRecord | undefined;
  http: Http;
  logsUrl: string;
  outbox: Outbox | null;
  drops: DropCounter;
  log: DebugLogger;
  clock: Clock;
  settings: { chunkMaxBytes: number; chunkMaxMs: number; keyframeIntervalMs: number; bufferSeconds: number; retryInitialMs: number; retryMaxMs: number; ttlMs: number };
  /** The stream ended by itself (failure, backlog): the controller forgets the engine. */
  onEnded(reason: EndReason): void;
  random?: () => number;
}

interface RawChunk {
  pieces: Uint8Array[];
  bytes: number;
  start: number;
  end: number;
  keyframe: boolean;
  view: string | undefined;
}

interface Encoded {
  body: Uint8Array;
  encoding: "gzip" | "identity";
  start: number;
  end: number;
  keyframe: boolean;
  view: string | undefined;
}

interface Outgoing {
  entry: OutboxEntry;
  bytes: number;
  segment: number;
  /** Outbox id once persisted. */
  id: number | null;
  /** Settles when the outbox has the chunk (or could not take it). The send waits for it (RPL-15). */
  persisted: Promise<void>;
  failures: number;
}

function concat(pieces: Uint8Array[], bytes: number): Uint8Array {
  if (pieces.length === 1) return pieces[0]!;
  const out = new Uint8Array(bytes);
  let off = 0;
  for (const p of pieces) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Rejected record count of an OTLP protobuf logs response. */
export function protoRejected(body: Uint8Array): number {
  const res = ProtobufLogsSerializer.deserializeResponse(body) as { partialSuccess?: { rejectedLogRecords?: number | string } } | undefined;
  return Number(res?.partialSuccess?.rejectedLogRecords ?? 0) || 0;
}

function serialize(record: ReadableLogRecord): Uint8Array {
  const bytes = ProtobufLogsSerializer.serializeRequest([record]);
  if (!bytes) throw new Error("replay record could not be serialized");
  return bytes;
}

const lockName = (stream: string): string => `ouo.replay.${stream}`;

function locks(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
}

export class ReplayEngine {
  readonly streamId = randomHex(16);
  readonly sessionId: string;
  private seq = 0;
  private segment = -1;
  private cur: RawChunk | null = null;
  private chunkTimer: TimerHandle | null = null;
  private keyTimer: TimerHandle | null = null;
  /** Encodes run one after the other so chunks keep their order. */
  private encoding: Promise<void> = Promise.resolve();
  private encodes = 0;
  private ring: Encoded[] = [];
  private triggered: Trigger | undefined;
  private out: Outgoing[] = [];
  private sending = false;
  private inflight: Outgoing | null = null;
  /** Page hide: chunks are stored now and sent by `flushUnload`, after telemetry (LIF-7). */
  private unloading = false;
  private retryTimer: TimerHandle | null = null;
  private partial = false;
  /** Data is discarded until the next keyframe (after a gap or a loss, RPL-8). */
  private needKeyframe = false;
  private ended = false;
  private running = false;
  private releaseLock: (() => void) | undefined;
  private row: StreamRow;

  constructor(private readonly d: EngineDeps) {
    this.sessionId = d.sessionId;
    this.row = { stream: this.streamId, replay: d.replayId, session: d.sessionId, last: -1, ended: false, partial: false, mode: d.mode, updatedAt: d.clock.now() };
  }

  /** Whether chunks are being sent (session mode, or a buffer that was triggered). */
  private get shipping(): boolean {
    return this.d.mode === "session" || this.triggered !== undefined;
  }

  start(): void {
    if (this.running || this.ended) return;
    this.running = true;
    // Held for the page's lifetime: a later page may only take over a stream whose lock is free.
    const l = locks();
    if (l?.request) {
      void quiet(
        l.request(lockName(this.streamId), () => new Promise<void>((resolve) => {
          this.releaseLock = resolve;
          if (this.ended) resolve();
        })),
      );
    }
    if (this.shipping) this.saveRow();
    const sink: AdapterSink = {
      data: (bytes, o) => attempt(() => this.onData(bytes, o.time, o.keyframe)),
      dropped: (reason) => {
        this.d.drops.add("ouo.replay.frame", reason);
        this.partial = true;
      },
      failed: () => void this.end("error"),
    };
    this.d.adapter.start(sink);
    this.armKeyframe();
  }

  /** A bypass-set record or `replay.capture()`: the ring is sent and recording goes on (SMP-12). */
  trigger(kind: Trigger): void {
    if (this.d.mode !== "buffer" || this.triggered || this.ended) return;
    this.triggered = kind;
    this.saveRow();
    // What was buffered goes first, in order, behind any encode still running.
    this.encoding = this.encoding.then(() => {
      const ring = this.ring;
      this.ring = [];
      return ring.reduce((p, c) => p.then(() => this.ship(c)), Promise.resolve());
    });
    void quiet(this.encoding);
    this.armKeyframe();
  }

  /** The page was hidden: the current chunk is closed (RPL-10). */
  onHidden(): void {
    this.cut();
    if (this.keyTimer !== null) this.d.clock.clearTimeout(this.keyTimer);
    this.keyTimer = null;
  }

  /** The page is visible again: a new segment starts with a keyframe (RPL-9). */
  onVisible(): void {
    if (!this.running || this.ended) return;
    this.d.adapter.requestKeyframe();
    this.armKeyframe();
  }

  /**
   * The page is going away (LIF-7): the current chunk is closed without compression, the end
   * record is made, and both are stored. Nothing here is awaited. `flushUnload` then sends what
   * fits the keepalive budget.
   */
  onPageHide(): void {
    if (this.ended) return;
    this.unloading = true;
    this.cutSync();
    this.finish("pagehide");
  }

  /**
   * Sends, with `keepalive`, the waiting chunks that fit what is left of the budget, in order
   * (TRN-16). Called after telemetry was flushed. A chunk that does not fit stays in the outbox.
   */
  flushUnload(): void {
    this.unloading = false;
    for (const o of [...this.out]) {
      // The chunk already on its way is not sent a second time.
      if (o === this.inflight) continue;
      const sent = this.d.http.post(this.d.logsUrl, o.entry.body, { contentType: PROTOBUF_CONTENT_TYPE, mustKeepalive: true, rejected: protoRejected });
      // The answer may never be seen: the stored copy stays until one is (TRN-19).
      void quiet(
        sent.then(async (res) => {
          if (!res || res.kind === "retry") return;
          this.out = this.out.filter((x) => x !== o);
          await o.persisted;
          if (o.id !== null) await this.d.outbox?.delete(o.id);
        }),
      );
    }
    // The page lived on (a bfcache candidate that was not closed): what is left goes the normal way.
    this.retryTimer ??= this.d.clock.setTimeout(() => {
      this.retryTimer = null;
      void this.pump();
    }, 2000);
  }

  /** Ends the stream normally and waits until what can be sent is sent. */
  async end(reason: EndReason): Promise<void> {
    if (this.ended) return;
    this.cut();
    await quiet(this.encoding);
    this.finish(reason);
    await quiet(this.idle());
  }

  /** Resolves when the send queue is empty or waiting for a retry. */
  async idle(): Promise<void> {
    await quiet(this.encoding);
    for (let i = 0; i < 50 && this.sending; i++) await new Promise((r) => setTimeout(r, 20));
  }

  /** Drops everything unsent (consent withdrawn). */
  async discard(): Promise<void> {
    this.out = [];
    this.ring = [];
    this.cur = null;
    this.finish("consent", true);
    await quiet(this.d.outbox?.clear("replay"));
  }

  // ---- capture ----

  private onData(bytes: Uint8Array, time: number, keyframe: boolean): void {
    if (this.ended) return;
    point("replay.data");
    if (this.needKeyframe) {
      if (!keyframe) return;
      this.needKeyframe = false;
    }
    if (keyframe && this.cur && this.cur.bytes > 0) this.cut();
    if (!this.cur) this.cur = { pieces: [], bytes: 0, start: time, end: time, keyframe, view: this.d.viewId() };
    const cur = this.cur;
    cur.pieces.push(bytes);
    cur.bytes += bytes.byteLength;
    cur.end = Math.max(cur.end, time);
    // Before compression, so a body can only come out smaller than the limit.
    if (cur.bytes >= this.d.settings.chunkMaxBytes) this.cut();
    else if (this.chunkTimer === null) this.chunkTimer = this.d.clock.setTimeout(() => this.cut(), this.d.settings.chunkMaxMs);
  }

  private take(): RawChunk | null {
    if (this.chunkTimer !== null) this.d.clock.clearTimeout(this.chunkTimer);
    this.chunkTimer = null;
    const raw = this.cur;
    this.cur = null;
    return raw && raw.bytes > 0 ? raw : null;
  }

  private cut(): void {
    const raw = this.take();
    if (!raw) return;
    this.encodes++;
    this.encoding = this.encoding
      .then(() => this.encode(raw))
      .then(
        () => undefined,
        () => {
          this.d.drops.add("ouo.replay.chunk", "internal_error");
          this.lost();
        },
      )
      .finally(() => {
        this.encodes--;
      });
  }

  /** The page-hide path: no compression, no awaiting. */
  private cutSync(): void {
    const raw = this.take();
    if (!raw) return;
    attempt(() => {
      for (const part of this.split(concat(raw.pieces, raw.bytes), CHUNK_HARD_LIMIT)) {
        const c: Encoded = { body: part.body, encoding: "identity", start: raw.start, end: raw.end, keyframe: raw.keyframe && part.first, view: raw.view };
        if (this.shipping) this.shipNow(c, sha256Sync(c.body));
      }
    });
  }

  private *split(body: Uint8Array, limit: number): Generator<{ body: Uint8Array; first: boolean }> {
    // Split, never truncated (RPL-11): the format is a stream of units, cut at any byte.
    for (let off = 0; off < body.byteLength; off += limit) yield { body: body.subarray(off, Math.min(body.byteLength, off + limit)), first: off === 0 };
  }

  private async encode(raw: RawChunk): Promise<void> {
    const plain = concat(raw.pieces, raw.bytes);
    const parts: Uint8Array[] = [plain];
    const gzip = this.d.adapter.compress && canGzip();
    let first = true;
    while (parts.length > 0) {
      const part = parts.shift()!;
      let body = part;
      let encoding: "gzip" | "identity" = "identity";
      if (gzip) {
        body = await gzipBytes(part);
        encoding = "gzip";
      }
      if (body.byteLength > this.d.settings.chunkMaxBytes && part.byteLength > 1) {
        // Still too large once compressed: halve the uncompressed bytes and try again.
        const mid = part.byteLength >> 1;
        parts.unshift(part.subarray(0, mid), part.subarray(mid));
        continue;
      }
      const c: Encoded = { body, encoding, start: raw.start, end: raw.end, keyframe: raw.keyframe && first, view: raw.view };
      first = false;
      if (this.ended) {
        // The page was closing while this was compressed: the stream's end record is already out.
        this.d.drops.add("ouo.replay.chunk", "backlog");
        continue;
      }
      if (this.shipping) await this.ship(c);
      else this.buffer(c);
    }
  }

  // ---- buffer ring ----

  private buffer(c: Encoded): void {
    this.ring.push(c);
    const horizon = this.d.clock.now() - this.d.settings.bufferSeconds * 1000;
    for (;;) {
      // Segments start at keyframe chunks; only whole segments leave (SMP-10).
      const second = this.ring.findIndex((x, i) => i > 0 && x.keyframe);
      if (second < 0) break;
      const bytes = this.ring.reduce((n, x) => n + x.body.byteLength, 0);
      // The oldest segment may go once the rest still covers the window, or when the ring is too big.
      if (this.ring[second]!.start > horizon && bytes <= RING_MAX_BYTES) break;
      this.ring.splice(0, second);
    }
    if (this.ring.reduce((n, x) => n + x.body.byteLength, 0) > RING_MAX_BYTES) void this.end("max_size");
  }

  // ---- chunk records ----

  private async ship(c: Encoded): Promise<void> {
    this.shipNow(c, await sha256(c.body));
  }

  private shipNow(c: Encoded, hash: string): void {
    if (this.ended) return;
    if (c.keyframe || this.segment < 0) this.segment++;
    const seq = this.seq++;
    const attributes: Record<string, AnyValue> = {
      "session.id": this.d.sessionId,
      "ouo.replay.id": this.d.replayId,
      "ouo.replay.stream.id": this.streamId,
      "ouo.replay.segment.index": this.segment,
      "ouo.replay.sequence": seq,
      "ouo.replay.keyframe": c.keyframe,
      "ouo.replay.start_time": Math.round(c.start),
      "ouo.replay.end_time": Math.round(c.end),
      "ouo.replay.format": this.d.adapter.format,
      "ouo.replay.encoding": c.encoding,
      "ouo.replay.sha256": hash,
      "ouo.replay.byte_size": c.body.byteLength,
      "ouo.replay.masked": true,
      "ouo.replay.mode": this.d.mode,
    };
    if (this.triggered) attributes["ouo.replay.trigger"] = this.triggered;
    if (c.view) attributes["ouo.view.id"] = c.view;
    const payload = this.record("ouo.replay.chunk", attributes, c.start, c.body);
    if (!payload) {
      this.d.drops.add("ouo.replay.chunk", "internal_error");
      this.lost();
      return;
    }
    this.row.last = seq;
    this.enqueue({ kind: "replay", signal: "replay", body: payload, records: 1, createdAt: this.d.clock.now(), stream: this.streamId, seq }, this.segment);
  }

  /** Makes one `ouo.replay` record through the Logs API and returns it as an OTLP protobuf request. */
  private record(name: string, attributes: Record<string, AnyValue>, time: number, body?: Uint8Array): Uint8Array | undefined {
    return attempt(() => {
      point("replay.record");
      const rec = this.d.makeRecord(name, attributes, time, this.d.clock.now(), body);
      return rec ? serialize(rec) : undefined;
    });
  }

  private finish(reason: EndReason, silent = false): void {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    attempt(() => this.d.adapter.stop());
    for (const t of [this.chunkTimer, this.keyTimer]) if (t !== null) this.d.clock.clearTimeout(t);
    this.chunkTimer = this.keyTimer = null;
    if (this.encodes > 0) this.partial = true;
    // A buffer that was never triggered sent nothing: no stream exists for the collector.
    if (this.shipping && !silent) {
      const attributes: Record<string, AnyValue> = {
        "session.id": this.d.sessionId,
        "ouo.replay.id": this.d.replayId,
        "ouo.replay.stream.id": this.streamId,
        "ouo.replay.end_state": this.partial ? "partial" : "complete",
        "ouo.replay.end_reason": reason,
      };
      if (this.seq > 0) attributes["ouo.replay.last_sequence"] = this.seq - 1;
      const payload = this.record("ouo.replay.ended", attributes, this.d.clock.now());
      if (payload) {
        this.row.ended = true;
        this.enqueue({ kind: "replay", signal: "replay", body: payload, records: 1, createdAt: this.d.clock.now(), stream: this.streamId, seq: -1 }, this.segment);
      }
    }
    this.releaseLock?.();
    this.releaseLock = undefined;
    this.d.onEnded(reason);
  }

  // ---- delivery ----

  private enqueue(entry: OutboxEntry, segment: number): void {
    const o: Outgoing = { entry, bytes: entry.body.byteLength, segment, id: null, persisted: Promise.resolve(), failures: 0 };
    this.out.push(o);
    this.saveRow();
    // Persisted before the first send (RPL-15); the write is started now, also at page hide.
    if (this.d.outbox) {
      o.persisted = quiet(
        this.d.outbox.put(entry).then((r) => {
          o.id = r.id;
          this.evicted(r.evicted);
          if (r.id === null) this.d.drops.add("ouo.replay.chunk", "storage_error");
        }),
      );
    }
    this.backlog();
    if (!this.unloading) void this.pump();
  }

  private evicted(metas: OutboxMeta[]): void {
    for (const m of metas) {
      this.d.drops.add(m.signal === "replay" ? "ouo.replay.chunk" : m.signal, "storage_full", m.records);
      if (m.stream === this.streamId) {
        // One of this stream's stored chunks made room for newer data.
        this.out = this.out.filter((o) => o.id !== m.id);
        this.lost();
      }
    }
  }

  /** Local loss: the stream is partial and the next data must start a new segment (RPL-8, RPL-17). */
  private lost(): void {
    this.partial = true;
    this.row.partial = true;
    if (!this.ended && this.running) {
      this.needKeyframe = true;
      this.cur = null;
      this.d.adapter.requestKeyframe();
    }
  }

  private backlog(): void {
    const total = (): number => this.out.reduce((n, o) => n + o.bytes, 0);
    if (total() <= BACKLOG_MAX_BYTES) return;
    // Whole chunks of the oldest segment, never the one being sent, never the end record.
    const head = this.sending ? this.out[0] : undefined;
    const oldest = this.out.find((o) => o !== head && o.entry.seq !== -1)?.segment;
    if (oldest !== undefined) {
      const dropped = this.out.filter((o) => o !== head && o.segment === oldest && o.entry.seq !== -1);
      this.out = this.out.filter((o) => !dropped.includes(o));
      for (const o of dropped) if (o.id !== null) void quiet(this.d.outbox?.delete(o.id));
      this.d.drops.add("ouo.replay.chunk", "backlog", dropped.length);
      this.lost();
    }
    // Still over: nothing more can be accepted, capture stops (RPL-18).
    if (total() > BACKLOG_MAX_BYTES && !this.ended) {
      this.partial = true;
      this.finish("max_size");
    }
  }

  private async pump(): Promise<void> {
    if (this.sending || this.retryTimer !== null) return;
    this.sending = true;
    try {
      while (this.out.length > 0) {
        const o = this.out[0]!;
        await o.persisted;
        if (this.out[0] !== o) continue;
        this.inflight = o;
        const res = await this.d.http.post(this.d.logsUrl, o.entry.body, { contentType: PROTOBUF_CONTENT_TYPE, rejected: protoRejected });
        this.inflight = null;
        if (!res || res.kind === "retry") {
          o.failures++;
          const delay = retryDelay(o.failures, res?.kind === "retry" ? res.retryAfterMs : undefined, this.d.settings.retryInitialMs, this.d.settings.retryMaxMs, this.d.random);
          this.retryTimer = this.d.clock.setTimeout(() => {
            this.retryTimer = null;
            void this.pump();
          }, delay);
          return;
        }
        if (this.out[0] === o) this.out.shift();
        // Durably accepted, or refused for good: either way the stored copy can go (TRN-12, TRN-13).
        if (o.id !== null) await quiet(this.d.outbox?.delete(o.id));
        if (res.kind !== "ok") {
          this.d.drops.add("ouo.replay.chunk", res.kind === "partial" ? "partial_rejected" : "rejected_status");
          if (o.entry.seq !== -1) {
            // The segment is broken: what is left of it cannot be decoded and is not sent (RPL-8).
            const rest = this.out.filter((x) => x.segment === o.segment && x.entry.seq !== -1);
            this.out = this.out.filter((x) => !rest.includes(x));
            for (const x of rest) void quiet(x.persisted.then(() => (x.id !== null ? this.d.outbox?.delete(x.id) : undefined)));
            if (rest.length > 0) this.d.drops.add("ouo.replay.chunk", "backlog", rest.length);
            this.lost();
          }
        }
      }
      if (this.ended && this.row.ended) await quiet(this.d.outbox?.deleteStream(this.streamId));
    } finally {
      this.inflight = null;
      this.sending = false;
    }
  }

  private saveRow(): void {
    if (!this.d.outbox) return;
    this.row.updatedAt = this.d.clock.now();
    this.row.partial = this.partial;
    void quiet(this.d.outbox.putStream({ ...this.row }));
  }

  private armKeyframe(): void {
    if (this.keyTimer !== null) this.d.clock.clearTimeout(this.keyTimer);
    this.keyTimer = null;
    if (this.ended) return;
    // A buffer that is not yet triggered takes keyframes often enough for the ring to turn over.
    const every = this.shipping ? this.d.settings.keyframeIntervalMs : Math.min(this.d.settings.keyframeIntervalMs, this.d.settings.bufferSeconds * 1000);
    this.keyTimer = this.d.clock.setTimeout(() => {
      this.keyTimer = null;
      this.d.adapter.requestKeyframe();
      this.armKeyframe();
    }, every);
  }
}

export interface RecoveryDeps {
  outbox: Outbox;
  http: Http;
  logsUrl: string;
  makeRecord(name: string, attributes: Record<string, AnyValue>, time: number, observed: number, body?: Uint8Array): ReadableLogRecord | undefined;
  drops: DropCounter;
  clock: Clock;
  ttlMs: number;
  /** Streams of this page, which are not recovered. */
  own: ReadonlySet<string>;
}

/** Streams whose page is gone without a lock API to prove it are taken over after this long. */
const STALE_STREAM_MS = 120_000;

/**
 * Sends what earlier pages of this origin left in the outbox (TRN-18): for every stream whose
 * page is gone (its Web Lock is free), the stored chunks in sequence order, then the end record
 * the page could not make, as `partial` (RPL-20). Returns true when nothing is left to recover.
 */
export async function recoverStreams(d: RecoveryDeps): Promise<boolean> {
  const now = d.clock.now();
  const { entries, expired } = await d.outbox.list(now, d.ttlMs);
  for (const m of expired) if (m.kind === "replay") d.drops.add("ouo.replay.chunk", "expired", m.records);
  const rows = await d.outbox.streams();
  let left = 0;
  for (const row of rows) {
    if (d.own.has(row.stream)) {
      left++;
      continue;
    }
    const mine = entries.filter((e) => e.kind === "replay" && e.stream === row.stream).sort((a, b) => (a.seq === -1 ? 1 : b.seq === -1 ? -1 : (a.seq ?? 0) - (b.seq ?? 0)));
    const drain = async (): Promise<boolean> => {
      for (const m of mine) {
        const body = await d.outbox.body(m.id);
        if (body) {
          const res = await d.http.post(d.logsUrl, body, { contentType: PROTOBUF_CONTENT_TYPE, rejected: protoRejected });
          if (!res || res.kind === "retry") return false;
          if (res.kind !== "ok") d.drops.add("ouo.replay.chunk", res.kind === "partial" ? "partial_rejected" : "rejected_status");
        } else d.drops.add("ouo.replay.chunk", "storage_error");
        await d.outbox.delete(m.id);
      }
      // The row may not have been rewritten at page close; a stored end record says the same.
      if (!row.ended && row.last >= 0 && !mine.some((m) => m.seq === -1)) {
        // The page died before it could say the stream was over.
        const rec = d.makeRecord(
          "ouo.replay.ended",
          {
            "session.id": row.session,
            "ouo.replay.id": row.replay,
            "ouo.replay.stream.id": row.stream,
            "ouo.replay.end_state": "partial",
            "ouo.replay.last_sequence": row.last,
            "ouo.replay.end_reason": "background_kill",
          },
          row.updatedAt,
          d.clock.now(),
        );
        if (rec) {
          const res = await d.http.post(d.logsUrl, serialize(rec), { contentType: PROTOBUF_CONTENT_TYPE, rejected: protoRejected });
          if (!res || res.kind === "retry") return false;
        }
      }
      await d.outbox.deleteStream(row.stream);
      return true;
    };
    const l = locks();
    let done: boolean;
    if (l?.request) done = (await l.request(lockName(row.stream), { ifAvailable: true }, (lock) => (lock ? drain() : false))) as boolean;
    else done = now - row.updatedAt > STALE_STREAM_MS ? await drain() : false;
    if (!done) left++;
  }
  // Chunks whose stream row is gone (written by a page that never stored one) are sent as they are.
  const known = new Set(rows.map((r) => r.stream));
  for (const m of entries) {
    if (m.kind !== "replay" || (m.stream && known.has(m.stream)) || now - m.createdAt < STALE_STREAM_MS) continue;
    const body = await d.outbox.body(m.id);
    if (body) {
      const res = await d.http.post(d.logsUrl, body, { contentType: PROTOBUF_CONTENT_TYPE, rejected: protoRejected });
      if (!res || res.kind === "retry") {
        left++;
        continue;
      }
    }
    await d.outbox.delete(m.id);
  }
  return left === 0;
}
