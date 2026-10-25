import type { DebugLogger } from "../logger";
import type { TransportOptions } from "../types";
import { Delivery } from "./delivery";
import { ResilientStore } from "./store";

export { Delivery, type DeliveryStats, type Outcome } from "./delivery";
export { createLogExporter, createTraceExporter } from "./exporter";

export const DEFAULT_OFFLINE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_OFFLINE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The one {@link Delivery} every ingest request of the SDK goes through, built from `initRUM({ transport })`. */
export function createDelivery(options: TransportOptions | undefined, logger: DebugLogger): Delivery {
  const offline = options?.offline;
  const store =
    offline === false
      ? null
      : new ResilientStore({ maxBytes: offline?.maxBytes ?? DEFAULT_OFFLINE_MAX_BYTES, logger });
  return new Delivery({
    logger,
    store,
    ...(options?.compression !== undefined ? { compression: options.compression } : {}),
    ...(options?.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options?.beacon !== undefined ? { beacon: options.beacon } : {}),
    maxAgeMs: (offline === false ? undefined : offline?.maxAgeMs) ?? DEFAULT_OFFLINE_MAX_AGE_MS,
  });
}
