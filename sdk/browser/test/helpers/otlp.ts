/** A stubbed fetch that records every request, and decoders for the OTLP/HTTP JSON it captured. */
import { vi } from "vitest";

export interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** The request body as sent (gzip replay chunks are an ArrayBuffer). */
  raw: unknown;
}

type Attr = { key: string; value: Record<string, unknown> };

export interface LogRecordOut {
  eventName: string;
  attributes: Record<string, unknown>;
  timeUnixNano: string;
  traceId?: string;
}

export interface SpanOut {
  name: string;
  attributes: Record<string, unknown>;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
}

function decodeBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  const isBuffer = ArrayBuffer.isView(body) || Object.prototype.toString.call(body) === "[object ArrayBuffer]";
  const text = typeof body === "string" ? body : isBuffer ? new TextDecoder().decode(body as ArrayBuffer) : String(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function attrs(list: Attr[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of list ?? []) {
    const v = a.value;
    out[a.key] = v["stringValue"] ?? v["intValue"] ?? v["doubleValue"] ?? v["boolValue"] ?? v;
  }
  return out;
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Installs a fetch stub answering 200 (or `status(url)`) and returns the capture with decoders. */
export function stubFetch(base: string, status: (url: string) => number = () => 200) {
  const captured: Captured[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, headers: headersToRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined)), body: decodeBody(init?.body), raw: init?.body });
    return new Response("{}", { status: status(url), headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const logRecords = (): LogRecordOut[] => {
    const out: LogRecordOut[] = [];
    for (const c of captured.filter((c) => c.url === `${base}/v1/logs`)) {
      const body = c.body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<LogRecordOut & { attributes: Attr[] }> }> }> };
      for (const rl of body.resourceLogs) for (const sl of rl.scopeLogs) for (const lr of sl.logRecords) out.push({ ...lr, attributes: attrs(lr.attributes) });
    }
    return out;
  };
  const spans = (): SpanOut[] => {
    const out: SpanOut[] = [];
    for (const c of captured.filter((c) => c.url === `${base}/v1/traces`)) {
      const body = c.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<SpanOut & { attributes: Attr[] }> }> }> };
      for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) for (const s of ss.spans) out.push({ ...s, attributes: attrs(s.attributes) });
    }
    return out;
  };
  return { captured, logRecords, spans };
}
