import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import type { Attrs } from "../types";
import type { DebugLogger } from "../logger";

export type Severity = "info" | "warn" | "error";

const SEVERITY: Record<Severity, { number: SeverityNumber; text: string }> = {
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
};

/** Emits ouo events as OTel log records with `event.name` (top-level and as attribute). */
export class EventEmitter {
  constructor(
    private readonly logger: Logger,
    private readonly debug: DebugLogger,
  ) {}

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
    });
  }
}
