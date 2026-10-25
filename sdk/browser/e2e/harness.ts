/**
 * Shared helpers for the end-to-end specs: read back what the collector stub (e2e/server.mjs)
 * received, decode it, reset it, and switch its fault mode. New specs import from here.
 */
import { expect, type Page } from "@playwright/test";

export const PAGE_PORT = Number(process.env.OUO_E2E_PAGE_PORT ?? 4180);
export const COLLECTOR_PORT = Number(process.env.OUO_E2E_COLLECTOR_PORT ?? PAGE_PORT + 1);
export const PAGES = `http://localhost:${PAGE_PORT}`;
export const COLLECTOR = `http://localhost:${COLLECTOR_PORT}`;
/** Nothing listens here: a collector that is down. */
export const DEAD_COLLECTOR_PORT = 4199;

type Attr = { key: string; value: Record<string, unknown> };
export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
}
export interface Log {
  eventName: string;
  attributes: Record<string, unknown>;
}
export interface ReplayChunk {
  session_id: string;
  seq: number;
  events: Array<{ type: number; data?: { tag?: string; payload?: { tab_id?: string } } }>;
}
interface Raw {
  traces: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Span & { attributes: Attr[] }> }> }> }>;
  logs: Array<{ resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<Log & { attributes: Attr[] }> }> }> }>;
  replay: ReplayChunk[];
  rejected: number;
  faulted: number;
}

export const attrs = (list: Attr[]): Record<string, unknown> =>
  Object.fromEntries(list.map((a) => [a.key, a.value["stringValue"] ?? a.value["intValue"] ?? a.value["doubleValue"] ?? a.value["boolValue"]]));

export async function captured(page: Page) {
  const c = (await (await page.request.get(`${COLLECTOR}/__captured`)).json()) as Raw;
  const spans: Span[] = c.traces.flatMap((t) => t.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.map((sp) => ({ ...sp, attributes: attrs(sp.attributes) })))));
  const logs: Log[] = c.logs.flatMap((l) => l.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords.map((lr) => ({ ...lr, attributes: attrs(lr.attributes) })))));
  return { spans, logs, replay: c.replay, rejected: c.rejected, faulted: c.faulted };
}

export async function resetCollector(page: Page): Promise<void> {
  await page.request.post(`${COLLECTOR}/__reset`);
}

/** Every ingest request gets this answer until cleared with `{}` (or `resetCollector`). */
export async function setCollectorFault(page: Page, fault: { status?: number; retryAfter?: number; delayMs?: number }): Promise<void> {
  await page.request.post(`${COLLECTOR}/__fault`, { data: fault });
}

/** Resets the stub and opens a page that sets `#status` to `ready`. */
export async function open(page: Page, path = "/"): Promise<void> {
  await resetCollector(page);
  await page.goto(path);
  await expect(page.locator("#status")).toHaveText("ready");
}

export const flush = (page: Page) => page.evaluate(() => (window as unknown as { rum?: { flush(): Promise<void> } }).rum?.flush());
