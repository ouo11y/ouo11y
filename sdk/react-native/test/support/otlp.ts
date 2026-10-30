/** OTLP capture for end-to-end tests of `initRUM`: a fetch stub that decodes the JSON exports. */
import type { GlobalErrorHandler } from "../../src/errors/install";
import { MemoryAsyncStorage } from "../../src/session/storage";

export interface OtlpAttr {
  key: string;
  value: { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number };
}
export interface OtlpLog {
  eventName?: string;
  timeUnixNano: string;
  body?: { stringValue?: string };
  traceId?: string;
  spanId?: string;
  severityNumber?: number;
  severityText?: string;
  attributes: OtlpAttr[];
}
export interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: number;
  status?: { code?: number; message?: string };
  events?: Array<{ name: string; attributes: OtlpAttr[] }>;
  attributes: OtlpAttr[];
}

export const attr = (attrs: OtlpAttr[], key: string): unknown => {
  const a = attrs.find((x) => x.key === key);
  if (!a) return undefined;
  const v = a.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.boolValue !== undefined) return v.boolValue;
  return v.doubleValue;
};

export const ENDPOINT = "http://otel.test:4318";
export const BACKEND = "http://backend.test";

export interface Captured {
  logs: OtlpLog[];
  spans: OtlpSpan[];
  resource: OtlpAttr[];
  requests: Array<{ url: string; headers: Record<string, string> }>;
  byName(name: string): OtlpLog[];
}

/** Replaces `globalThis.fetch`: collector exports are decoded, app requests answer by URL (`fail=500`, `/missing` 404, else 200). */
export function installFetchStub(): Captured {
  const captured: Captured = {
    logs: [],
    spans: [],
    resource: [],
    requests: [],
    byName: (name) => captured.logs.filter((l) => attr(l.attributes, "event.name") === name),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith(ENDPOINT)) {
      const json = JSON.parse(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array)) as {
        resourceLogs?: Array<{ resource: { attributes: OtlpAttr[] }; scopeLogs: Array<{ logRecords: OtlpLog[] }> }>;
        resourceSpans?: Array<{ resource: { attributes: OtlpAttr[] }; scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
      };
      for (const rl of json.resourceLogs ?? []) {
        captured.resource = rl.resource.attributes;
        for (const sl of rl.scopeLogs) captured.logs.push(...sl.logRecords);
      }
      for (const rs of json.resourceSpans ?? []) {
        captured.resource = rs.resource.attributes;
        for (const ss of rs.scopeSpans) captured.spans.push(...ss.spans);
      }
      return new Response("{}", { status: 200 });
    }
    captured.requests.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    if (url.includes("network-down")) throw new TypeError("Network request failed");
    if (url.includes("fail=500")) return new Response("{}", { status: 500 });
    if (url.includes("/missing")) return new Response("{}", { status: 404 });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  return captured;
}

export const g = globalThis as {
  ErrorUtils?: { getGlobalHandler: () => GlobalErrorHandler; setGlobalHandler: (h: GlobalErrorHandler) => void };
  HermesInternal?: unknown;
  __ouoSessionProcessState?: unknown;
  expo?: { modules?: Record<string, unknown> };
};

/** Fake ErrorUtils whose default handler records its calls. */
export function installErrorUtils(): Array<[unknown, boolean | undefined]> {
  const calls: Array<[unknown, boolean | undefined]> = [];
  let handler: GlobalErrorHandler = (e, f) => {
    calls.push([e, f]);
  };
  g.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (h) => (handler = h) };
  return calls;
}

export function baseOptions(storage = new MemoryAsyncStorage()) {
  return {
    endpoint: ENDPOINT,
    projectId: "demo",
    projectToken: "pt_test_token_0000000000000000",
    service: { name: "mobile-store", version: "2.3.0", environment: "test" },
    tracing: { propagateTo: [BACKEND] },
    storage,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(5);
}
