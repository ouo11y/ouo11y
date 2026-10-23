import type { Context } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import type { DebugLogger } from "../logger";
import type { Attrs } from "../types";

export type Severity = "info" | "warn" | "error";

const SEVERITY: Record<Severity, { number: SeverityNumber; text: string }> = {
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
};

export interface EmitOptions {
  /** Record body; defaults to the event name. The bridge sets readable bodies on timeline events (`GET <url>`, `app background`). */
  body?: string;
  /** Trace context of the record (trace id, span id): a request's span, the active span, an error's span. */
  context?: Context;
}

/** Listener that sees every event before it is emitted (vitals, de-duplication). */
export type EmitListener = (name: string, attributes: Attrs, timestamp: number) => void;

/** Emits ouo events as OTel log records with `event.name` (top-level and as attribute). */
export class EventEmitter {
  private readonly listeners = new Set<EmitListener>();

  constructor(
    private readonly logger: Logger,
    private readonly debug: DebugLogger,
  ) {}

  emit(name: string, attributes: Attrs = {}, severity: Severity = "info", timestamp: number = Date.now(), options: EmitOptions = {}): void {
    const sev = SEVERITY[severity];
    this.debug.log("event", name, attributes);
    for (const l of this.listeners) {
      try {
        l(name, attributes, timestamp);
      } catch {
        // a listener never breaks emission
      }
    }
    this.logger.emit({
      eventName: name,
      body: options.body ?? name,
      timestamp,
      severityNumber: sev.number,
      severityText: sev.text,
      attributes: { "event.name": name, ...attributes },
      ...(options.context ? { context: options.context } : {}),
    });
  }

  /** Raw log record (the public log API): any severity, no `event.name` unless given. */
  emitRecord(record: Parameters<Logger["emit"]>[0]): void {
    this.logger.emit(record);
  }

  onEmit(listener: EmitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
