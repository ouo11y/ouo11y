import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { JsonLogsSerializer, JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { Delivery } from "./delivery";
import { KEEPALIVE_MAX_BYTES, keepaliveRemaining } from "./keepalive";

interface Serializer<T> {
  serializeRequest(items: T[]): Uint8Array | undefined;
}

export interface OtlpExporterOptions {
  /** `${endpoint}/v1/traces` or `/v1/logs`. */
  url: string;
  /** Headers on every request (`Authorization`). */
  headers: Record<string, string>;
  delivery: Delivery;
}

/**
 * OTLP/HTTP JSON exporter over {@link Delivery} (gzip, retry, keepalive, offline store), in
 * place of the OTel browser exporters' fetch transport. At page hide a batch too large for
 * what is left of the keepalive budget is split until each part fits, so the last spans and
 * logs leave with the page instead of waiting in the store for the next one.
 */
export class OtlpJsonExporter<T> {
  constructor(
    private readonly serializer: Serializer<T>,
    private readonly label: string,
    private readonly opts: OtlpExporterOptions,
  ) {}

  export(items: T[], resultCallback: (result: ExportResult) => void): void {
    // Delivery never rejects: drops are counted there. The batcher only needs to know it is done.
    Promise.all(this.parts(items).map((body) => this.opts.delivery.send({ url: this.opts.url, headers: this.opts.headers, body, label: this.label }))).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: Error) => resultCallback({ code: ExportResultCode.FAILED, error }),
    );
  }

  /** Serialized bodies: one, or at page hide as many as it takes to fit the keepalive budget. */
  parts(items: T[]): Uint8Array[] {
    if (items.length === 0) return [];
    const body = this.serializer.serializeRequest(items);
    if (!body) return [];
    if (!this.opts.delivery.urgent() || items.length === 1) return [body];
    const budget = Math.min(KEEPALIVE_MAX_BYTES, Math.max(keepaliveRemaining(), 1));
    if (body.byteLength <= budget) return [body];
    const mid = Math.ceil(items.length / 2);
    return [...this.parts(items.slice(0, mid)), ...this.parts(items.slice(mid))];
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function createTraceExporter(opts: OtlpExporterOptions): OtlpJsonExporter<ReadableSpan> {
  return new OtlpJsonExporter(JsonTraceSerializer as Serializer<ReadableSpan>, "traces", { ...opts, headers: { "content-type": "application/json", ...opts.headers } });
}

export function createLogExporter(opts: OtlpExporterOptions): OtlpJsonExporter<ReadableLogRecord> {
  return new OtlpJsonExporter(JsonLogsSerializer as Serializer<ReadableLogRecord>, "logs", { ...opts, headers: { "content-type": "application/json", ...opts.headers } });
}
