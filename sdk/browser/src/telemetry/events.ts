import { ROOT_CONTEXT } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import type { Attrs } from "../types";
import type { DebugLogger } from "../logger";

export type Severity = "info" | "warn" | "error";

const SEVERITY: Record<Severity, { number: SeverityNumber; text: string }> = {
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
};

export type EventListener = (name: string, attributes: Attrs, severity: Severity) => void;

/**
 * Emits ouo events as OTel log records with `event.name` (top-level and as attribute). Records
 * are emitted in the root context: an open click or soft-navigation span is the fallback active
 * context (FallbackContextManager), and a click span without children is never exported, so a
 * trace id from it would point nowhere.
 */
export class EventEmitter {
  private readonly listeners = new Set<EventListener>();

  constructor(
    private readonly logger: Logger,
    private readonly debug: DebugLogger,
  ) {}

  /** Called for every emitted event (error-triggered replay listens for exceptions). */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(name: string, attributes: Attrs = {}, severity: Severity = "info", timestamp: number = Date.now()): void {
    const sev = SEVERITY[severity];
    this.debug.log("event", name, attributes);
    this.logger.emit({
      eventName: name,
      body: name,
      timestamp,
      severityNumber: sev.number,
      severityText: sev.text,
      attributes: { "event.name": name, ...attributes },
      context: ROOT_CONTEXT,
    });
    for (const l of this.listeners) l(name, attributes, severity);
  }
}
