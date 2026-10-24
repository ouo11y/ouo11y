// Frontend logs: `log.info / log.warn / log.error`, each an OpenTelemetry log record.
// @ouo11y/browser registers the global LoggerProvider, so these records get the session id,
// user id, page and route like the SDK's own events, and go to Loki through the collector.
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const logger = logs.getLogger("tiny-shop-signals-frontend");

function emit(severityNumber, severityText, body, attributes) {
  logger.emit({ severityNumber, severityText, body, attributes });
}

export const log = {
  info: (message, attrs) => emit(SeverityNumber.INFO, "INFO", message, attrs),
  warn: (message, attrs) => emit(SeverityNumber.WARN, "WARN", message, attrs),
  error: (message, attrs) => emit(SeverityNumber.ERROR, "ERROR", message, attrs),
};
