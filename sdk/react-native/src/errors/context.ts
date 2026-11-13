import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import { guard } from "../guard";
import type { DebugLogger } from "../logger";
import { lastEventsAttribute, type RecentEvent } from "../telemetry/recent";
import type { AsyncKeyValueStorage, Attrs } from "../types";

/**
 * Error context (docs/specs/mobile-sdk.md C2): what every `exception` carries besides its stack,
 * so it reads without the replay: the session's last timeline events (`ouo.last_events`, the
 * buffer `feedback` uses), the screen, the device locale, the app's memory and the network type.
 *
 * A native crash or a termination is reported by the next launch, when this run's buffer is gone:
 * the screen and the last events are persisted (`ouo.context`): at once after a tap, a navigation
 * or an exception (the steps a reader needs, and the tap that triggered a synchronous native crash),
 * at most every 5 s after other records (a termination is dated to a 5 s heartbeat anyway), and
 * on background and flush. The next launch adds the crashed session's to its report. Memory and network
 * are what the device has at the time of the error, so a report from a previous run has none.
 */
export const CONTEXT_STORAGE_KEY = "ouo.context";
/** Longest wait between a record other than a tap, navigation or exception and the persisted context. */
export const CONTEXT_PERSIST_DELAY_MS = 5000;
/** Records persisted at once. */
const PERSIST_AT_ONCE = new Set(["ui.tap", "navigation", "exception"]);

/** The native module's part (iOS: `ErrorContext` in sdk/ios OuoCrash). */
export interface NativeErrorContextModule {
  getErrorContext?(): { memoryFootprintBytes?: number; memoryAvailableBytes?: number; networkType?: string } | null | undefined;
}

export interface ScreenContext {
  sessionId: string;
  screen: string;
  events: RecentEvent[];
}

/** `app.screen.name` and `ouo.last_events`, when there is a screen and there are events. */
export function screenContextAttributes(c: Pick<ScreenContext, "screen" | "events">): Attrs {
  const attrs: Attrs = {};
  if (c.screen) attrs["app.screen.name"] = c.screen;
  if (c.events.length > 0) attrs["ouo.last_events"] = lastEventsAttribute(c.events);
  return attrs;
}

/** Locale, memory and network now; what the platform does not give is left out (spec rule 5). */
export function deviceContextAttributes(locale: string | undefined, native: NativeErrorContextModule | undefined, logger: DebugLogger): Attrs {
  const attrs: Attrs = {};
  if (locale) attrs["ouo.device.locale"] = locale;
  if (typeof native?.getErrorContext !== "function") return attrs;
  try {
    const c = native.getErrorContext();
    if (typeof c?.memoryFootprintBytes === "number") attrs["ouo.memory.app_bytes"] = c.memoryFootprintBytes;
    if (typeof c?.memoryAvailableBytes === "number") attrs["ouo.memory.available_bytes"] = c.memoryAvailableBytes;
    if (typeof c?.networkType === "string" && c.networkType) attrs["network.connection.type"] = c.networkType;
  } catch (err) {
    logger.warn("error context: getErrorContext failed", err);
  }
  return attrs;
}

/** The device's locale (BCP 47), from Hermes' Intl; undefined without it. */
export function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
}

export function parseScreenContext(raw: string | null): ScreenContext | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(raw) as Partial<ScreenContext>;
    if (typeof c?.sessionId !== "string" || !Array.isArray(c.events)) return undefined;
    return { sessionId: c.sessionId, screen: typeof c.screen === "string" ? c.screen : "", events: c.events };
  } catch {
    return undefined;
  }
}

/**
 * Persists the screen context after records are emitted: at once after a tap, navigation or
 * exception, else one write at most every CONTEXT_PERSIST_DELAY_MS (trailing), and at once on
 * `persistNow()` (background, flush). A log processor after `RecentEvents`, so the record is
 * already in the buffer it reads.
 */
export class ContextPersister implements LogRecordProcessor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = "";

  constructor(
    private readonly storage: AsyncKeyValueStorage,
    /** Undefined when there is no current session to describe. */
    private readonly read: () => ScreenContext | undefined,
  ) {}

  onEmit(record: SdkLogRecord): void {
    const name = record.attributes["event.name"] ?? record.eventName;
    if (typeof name === "string" && PERSIST_AT_ONCE.has(name)) {
      this.persistNow();
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(
      guard.wrap("timer.context", () => this.persistNow()),
      CONTEXT_PERSIST_DELAY_MS,
    );
  }

  persistNow(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const c = this.read();
    if (!c) return;
    const raw = JSON.stringify(c);
    if (raw === this.last) return;
    this.last = raw;
    void this.storage.setItem(CONTEXT_STORAGE_KEY, raw);
  }

  forceFlush(): Promise<void> {
    this.persistNow();
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return Promise.resolve();
  }
}
