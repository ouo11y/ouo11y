/**
 * Shared helpers for the end-to-end specs: read back what the collector stub (e2e/server.mjs)
 * received, decode it, reset it, and switch its fault mode.
 */
import { gunzipSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import { decodeProtoLogs, type ReplayRecord } from "../test/helpers/proto";

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
  events?: unknown[];
}
export interface Log {
  eventName: string;
  timeUnixNano: string;
  attributes: Record<string, unknown>;
  scope: string;
}
interface Raw {
  traces: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Span & { attributes: Attr[] }> }> }> }>;
  logs: Array<{ resourceLogs: Array<{ scopeLogs: Array<{ scope?: { name?: string }; logRecords: Array<Log & { attributes: Attr[] }> }> }> }>;
  replay: string[];
  rejected: number;
  faulted: number;
  requests: Array<{ path: string; status: number; type: string | null; bytes: number; at: number }>;
}

export const attrs = (list: Attr[] | undefined): Record<string, unknown> =>
  Object.fromEntries((list ?? []).map((a) => [a.key, a.value["stringValue"] ?? (a.value["intValue"] !== undefined ? Number(a.value["intValue"]) : undefined) ?? a.value["doubleValue"] ?? a.value["boolValue"]]));

export async function captured(page: Page) {
  const c = (await (await page.request.get(`${COLLECTOR}/__captured`)).json()) as Raw;
  const spans: Span[] = c.traces.flatMap((t) => t.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.map((sp) => ({ ...sp, attributes: attrs(sp.attributes) })))));
  const logs: Log[] = c.logs.flatMap((l) => l.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords.map((lr) => ({ ...lr, eventName: lr.eventName ?? "", attributes: attrs(lr.attributes), scope: s.scope?.name ?? "" })))));
  const replay: ReplayRecord[] = c.replay.flatMap((b64) => decodeProtoLogs(new Uint8Array(Buffer.from(b64, "base64"))));
  const events = (name: string): Log[] => logs.filter((l) => l.eventName === name);
  // Delivery is at least once: a chunk identity (stream, sequence) that arrived twice is one chunk.
  const seen = new Set<string>();
  const chunks = replay
    .filter((r) => r.eventName === "ouo.replay.chunk")
    .filter((r) => {
      const key = `${String(r.attributes["ouo.replay.stream.id"])}/${String(r.attributes["ouo.replay.sequence"])}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .sort((a, b) => Number(a.attributes["ouo.replay.sequence"]) - Number(b.attributes["ouo.replay.sequence"]));
  const ended = replay.filter((r) => r.eventName === "ouo.replay.ended");
  return { spans, logs, events, replay, chunks, ended, rejected: c.rejected, faulted: c.faulted, requests: c.requests };
}

/** The decompressed payload of a list of chunks, concatenated in order. */
export function payload(chunks: ReplayRecord[]): Buffer {
  return Buffer.concat(chunks.map((c) => (c.attributes["ouo.replay.encoding"] === "gzip" ? gunzipSync(Buffer.from(c.body!)) : Buffer.from(c.body!))));
}

export async function resetCollector(page: Page): Promise<void> {
  await page.request.post(`${COLLECTOR}/__reset`);
}

/** Every ingest request gets this answer until cleared with `{}` (or `resetCollector`). */
export async function setCollectorFault(page: Page, fault: { status?: number; retryAfter?: number; delayMs?: number; count?: number }): Promise<void> {
  await page.request.post(`${COLLECTOR}/__fault`, { data: fault });
}

/** Resets the stub and opens a page that sets `#status` to `ready`. */
export async function open(page: Page, path = "/"): Promise<void> {
  await resetCollector(page);
  await page.goto(path);
  await expect(page.locator("#status")).toHaveText("ready");
}

type Sdk = { flush(): Promise<void>; getSessionId(): string | undefined; diagnostics(): { state: string; internalErrors: number; replayRecording: boolean; dropped: unknown[] } };
export const flush = (page: Page) => page.evaluate(() => (window as unknown as { ouo: Sdk }).ouo.flush());
export const sessionId = (page: Page) => page.evaluate(() => (window as unknown as { ouo: Sdk }).ouo.getSessionId());
export const diagnostics = (page: Page) => page.evaluate(() => (window as unknown as { ouo: Sdk }).ouo.diagnostics());
export const pageErrors = (page: Page) => page.evaluate(() => (window as unknown as { pageErrors: string[] }).pageErrors);
