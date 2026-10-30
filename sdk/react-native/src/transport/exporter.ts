import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { JsonLogsSerializer, JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { Outbox } from "./outbox";

interface Serializer<T> {
  serializeRequest(items: T[]): Uint8Array | undefined;
}

/**
 * OTLP/HTTP JSON exporter that hands each batch to the {@link Outbox} (persisted, then sent
 * gzip with retries) in place of the OTel exporters' own transport. An export succeeds once the
 * batch is persisted: from then on losing it is the outbox's business, not the batcher's.
 */
export class OutboxExporter<T> {
  constructor(
    private readonly serializer: Serializer<T>,
    private readonly url: string,
    private readonly outbox: Outbox,
  ) {}

  export(items: T[], resultCallback: (result: ExportResult) => void): void {
    const bytes = items.length > 0 ? this.serializer.serializeRequest(items) : undefined;
    if (!bytes) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    this.outbox.put(this.url, utf8Decode(bytes)).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: Error) => resultCallback({ code: ExportResultCode.FAILED, error }),
    );
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function createTraceExporter(url: string, outbox: Outbox): SpanExporter {
  return new OutboxExporter<ReadableSpan>(JsonTraceSerializer as Serializer<ReadableSpan>, url, outbox);
}

export function createLogExporter(url: string, outbox: Outbox): LogRecordExporter {
  return new OutboxExporter<ReadableLogRecord>(JsonLogsSerializer as Serializer<ReadableLogRecord>, url, outbox);
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
