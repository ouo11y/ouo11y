import { context, TraceFlags, type Context } from "@opentelemetry/api";
import { suppressTracing, type ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, LogRecordProcessor, ReadableLogRecord, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { systemClock, type Clock } from "../session/clock";

export interface BatchOptions {
  /** Export at least this often while records are queued. */
  scheduledDelayMillis: number;
  maxExportBatchSize: number;
  /** Records beyond this many queued ones are dropped. */
  maxQueueSize: number;
  clock?: Clock;
}

interface Exporter<T> {
  export(items: T[], resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
}

/**
 * Batching for page lifetimes. The OTel batch processors run one flush at a time: `forceFlush`
 * waits for the export in flight to be answered, and a flush requested during a flush returns
 * at once without exporting. When a page is hidden or closed that loses the last records:
 * Chromium fires `pagehide` (the SDK flushes, an export goes out) and then `visibilitychange`
 * (web-vitals reports CLS and INP), whose flush is skipped, and the page is gone before the
 * first export is answered. This batcher sends every flush right away, concurrently with exports
 * in flight; the OTLP fetch transport adds `keepalive` within the browser's budget.
 */
export class Batcher<T> {
  private queue: T[] = [];
  private timer: unknown = null;
  private readonly pending = new Set<Promise<void>>();
  private readonly clock: Clock;

  constructor(
    private readonly exporter: Exporter<T>,
    private readonly opts: BatchOptions,
  ) {
    this.clock = opts.clock ?? systemClock;
  }

  add(item: T): void {
    if (this.queue.length >= this.opts.maxQueueSize) return;
    this.queue.push(item);
    if (this.queue.length >= this.opts.maxExportBatchSize) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.opts.scheduledDelayMillis);
    }
  }

  /** Exports everything queued now, and resolves when every export in flight is answered. */
  flush(): Promise<void> {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    while (this.queue.length > 0) this.send(this.queue.splice(0, this.opts.maxExportBatchSize));
    return Promise.all([...this.pending]).then(() => undefined);
  }

  async shutdown(): Promise<void> {
    await this.flush();
    await this.exporter.shutdown();
  }

  queued(): number {
    return this.queue.length;
  }

  private send(batch: T[]): void {
    const p = new Promise<void>((resolve) => {
      // Suppressed so an instrumented transport never traces the export itself.
      context.with(suppressTracing(context.active()), () => this.exporter.export(batch, () => resolve()));
    });
    this.pending.add(p);
    void p.then(() => this.pending.delete(p));
  }
}

/** Span processor exporting sampled spans through a {@link Batcher}. */
export class PageSpanProcessor implements SpanProcessor {
  private readonly batcher: Batcher<ReadableSpan>;

  constructor(exporter: SpanExporter, opts: BatchOptions) {
    this.batcher = new Batcher(exporter, opts);
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return;
    this.batcher.add(span);
  }

  forceFlush(): Promise<void> {
    return this.batcher.flush();
  }

  shutdown(): Promise<void> {
    return this.batcher.shutdown();
  }
}

/** Log record processor exporting through a {@link Batcher}. */
export class PageLogRecordProcessor implements LogRecordProcessor {
  private readonly batcher: Batcher<ReadableLogRecord>;

  constructor(exporter: LogRecordExporter, opts: BatchOptions) {
    this.batcher = new Batcher(exporter, opts);
  }

  onEmit(record: SdkLogRecord): void {
    this.batcher.add(record);
  }

  forceFlush(): Promise<void> {
    return this.batcher.flush();
  }

  shutdown(): Promise<void> {
    return this.batcher.shutdown();
  }
}
