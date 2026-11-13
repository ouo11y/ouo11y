import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { JsonLogsSerializer, JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { isDropEvent } from "../drops";
import { guard } from "../guard";
import { isBypassRecord } from "../sampling";
import type { Outbox } from "./outbox";

interface Serializer<T> {
  serializeRequest(items: T[]): Uint8Array | undefined;
}

/**
 * OTLP/HTTP JSON exporter that hands each batch to the {@link Outbox} (persisted, then sent
 * gzip with retries) in place of the OTel exporters' own transport. An export succeeds once the
 * batch is persisted: from then on losing it is the outbox's business, not the batcher's.
 */
/** Spec default of `transport.maxRequestBytes`. The SDK measures the request before gzip, so it is on the safe side. */
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

export interface ExporterOptions<T> {
  /** How many of the items count as records when the request is dropped (not the SDK's own drop reports). */
  records?: (items: T[]) => number;
  /** Whether an item is in the bypass set: its request is evicted last. */
  bypass?: (item: T) => boolean;
  maxRequestBytes?: number;
  /** A record that alone is over `maxRequestBytes`: dropped, reported here. */
  onTooLarge?: () => void;
}

export class OutboxExporter<T> {
  constructor(
    private readonly serializer: Serializer<T>,
    private readonly url: string,
    private readonly outbox: Outbox,
    private readonly options: ExporterOptions<T> = {},
  ) {}

  /** Inside the guard (ERR-1): a serializer or outbox that throws fails the export, it does not throw into the batcher. */
  export(items: T[], resultCallback: (result: ExportResult) => void): void {
    let answered = false;
    const answer = (result: ExportResult): void => {
      if (answered) return;
      answered = true;
      resultCallback(result);
    };
    const failed = (error: unknown): void => {
      guard.report("exporter", error);
      answer({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    };
    try {
      // TRN-4: an empty request is never sent.
      if (items.length === 0) {
        answer({ code: ExportResultCode.SUCCESS });
        return;
      }
      Promise.all(this.requests(items).map((r) => this.outbox.put(this.url, r.body, r.records, r.bypass))).then(() => answer({ code: ExportResultCode.SUCCESS }), failed);
    } catch (error) {
      failed(error);
    }
  }

  /** The batch as requests of at most `maxRequestBytes` each (TRN-4): split in halves until they fit. */
  private requests(items: T[]): Array<{ body: string; records: number; bypass: boolean }> {
    const bytes = this.serializer.serializeRequest(items);
    if (!bytes) return [];
    const max = this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (bytes.length > max) {
      if (items.length === 1) {
        this.options.onTooLarge?.();
        return [];
      }
      const half = Math.ceil(items.length / 2);
      return [...this.requests(items.slice(0, half)), ...this.requests(items.slice(half))];
    }
    const bypass = this.options.bypass;
    return [{ body: utf8Decode(bytes), records: this.options.records ? this.options.records(items) : items.length, bypass: bypass ? items.some(bypass) : false }];
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface TransportLimits {
  maxRequestBytes?: number;
  /** Counts a record dropped because it alone is over the limit. */
  onTooLarge?: (signal: "span" | "log") => void;
}

export function createTraceExporter(url: string, outbox: Outbox, limits: TransportLimits = {}): SpanExporter {
  return new OutboxExporter<ReadableSpan>(JsonTraceSerializer as Serializer<ReadableSpan>, url, outbox, {
    ...(limits.maxRequestBytes !== undefined ? { maxRequestBytes: limits.maxRequestBytes } : {}),
    onTooLarge: () => limits.onTooLarge?.("span"),
  });
}

export function createLogExporter(url: string, outbox: Outbox, limits: TransportLimits = {}): LogRecordExporter {
  return new OutboxExporter<ReadableLogRecord>(JsonLogsSerializer as Serializer<ReadableLogRecord>, url, outbox, {
    records: (items) => items.filter((r) => !isDropEvent(r.attributes["event.name"])).length,
    bypass: (r) => isBypassRecord(r.attributes),
    ...(limits.maxRequestBytes !== undefined ? { maxRequestBytes: limits.maxRequestBytes } : {}),
    onTooLarge: () => limits.onTooLarge?.("log"),
  });
}

/** UTF-8 bytes to a string; `TextDecoder` where the runtime has it (Hermes may not). */
export function utf8Decode(bytes: Uint8Array): string {
  const TD = (globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } }).TextDecoder;
  if (typeof TD === "function") return new TD().decode(bytes);
  let out = "";
  let chunk: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]!;
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++]! & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    if (cp > 0xffff) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      chunk.push(cp);
    }
    if (chunk.length >= 4096) {
      out += String.fromCharCode(...chunk);
      chunk = [];
    }
  }
  return out + String.fromCharCode(...chunk);
}
