/**
 * A fake Collector for the unit tests: replaces `fetch`, records every request the SDK makes,
 * decodes OTLP JSON (telemetry) and OTLP protobuf (replay), and answers with whatever the test
 * asked for (status, `Retry-After`, a partial-success body, a network failure).
 */
import { vi } from "vitest";

export interface CapturedLog {
  eventName: string;
  attributes: Record<string, unknown>;
  body: unknown;
  severityText?: string;
  timeUnixNano: string;
  observedTimeUnixNano: string;
  scope: string;
  schemaUrl: string;
  resource: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}
export interface CapturedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: number;
  attributes: Record<string, unknown>;
  events: unknown[];
  scope: string;
  schemaUrl: string;
  flags?: number;
}
export interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  keepalive: boolean;
}
export interface ReplayRecord {
  eventName: string;
  attributes: Record<string, unknown>;
  body: Uint8Array | undefined;
  scope: string;
  schemaUrl: string;
}
export type Answer = { status?: number; retryAfter?: string; body?: string | Uint8Array; fail?: boolean };

type KV = { key: string; value: Record<string, unknown> };
const value = (v: Record<string, unknown>): unknown =>
  v["stringValue"] ?? (v["intValue"] !== undefined ? Number(v["intValue"]) : undefined) ?? v["doubleValue"] ?? v["boolValue"] ?? (v["arrayValue"] as unknown) ?? (v["kvlistValue"] as unknown);
const attrs = (list: KV[] | undefined): Record<string, unknown> => Object.fromEntries((list ?? []).map((a) => [a.key, value(a.value)]));

// ---- a minimal protobuf reader, enough for an OTLP logs request ----
interface Field {
  no: number;
  wire: number;
  varint?: number;
  bytes?: Uint8Array;
}
function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): number => {
    let shift = 0;
    let n = 0;
    for (;;) {
      const b = buf[i++]!;
      n += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return n;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const tag = varint();
    const no = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ no, wire, varint: varint() });
    else if (wire === 2) {
      const len = varint();
      out.push({ no, wire, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) {
      out.push({ no, wire, bytes: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 5) {
      out.push({ no, wire, bytes: buf.subarray(i, i + 4) });
      i += 4;
    } else throw new Error(`wire type ${wire}`);
  }
  return out;
}
const text = (b: Uint8Array | undefined): string => new TextDecoder().decode(b ?? new Uint8Array());
function anyValue(buf: Uint8Array): unknown {
  for (const f of fields(buf)) {
    if (f.no === 1) return text(f.bytes);
    if (f.no === 2) return f.varint === 1;
    if (f.no === 3) return f.varint;
    if (f.no === 4) return new DataView(f.bytes!.buffer, f.bytes!.byteOffset, 8).getFloat64(0, true);
    if (f.no === 7) return f.bytes!.slice();
  }
  return undefined;
}
function keyValues(list: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of list) {
    const kv = fields(f.bytes!);
    out[text(kv.find((x) => x.no === 1)?.bytes)] = anyValue(kv.find((x) => x.no === 2)?.bytes ?? new Uint8Array());
  }
  return out;
}
export function decodeProtoLogs(buf: Uint8Array): ReplayRecord[] {
  const out: ReplayRecord[] = [];
  for (const rl of fields(buf).filter((f) => f.no === 1)) {
    for (const sl of fields(rl.bytes!).filter((f) => f.no === 2)) {
      const sf = fields(sl.bytes!);
      const scope = text(fields(sf.find((f) => f.no === 1)?.bytes ?? new Uint8Array()).find((f) => f.no === 1)?.bytes);
      const schemaUrl = text(sf.find((f) => f.no === 3)?.bytes);
      for (const lr of sf.filter((f) => f.no === 2)) {
        const lf = fields(lr.bytes!);
        const bodyField = lf.find((f) => f.no === 5);
        const body = bodyField ? anyValue(bodyField.bytes!) : undefined;
        out.push({
          eventName: text(lf.find((f) => f.no === 12)?.bytes),
          attributes: keyValues(lf.filter((f) => f.no === 6)),
          body: body instanceof Uint8Array ? body : undefined,
          scope,
          schemaUrl,
        });
      }
    }
  }
  return out;
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Response(data as BodyInit).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

export class FakeCollector {
  readonly requests: CapturedRequest[] = [];
  readonly logs: CapturedLog[] = [];
  readonly spans: CapturedSpan[] = [];
  readonly replay: ReplayRecord[] = [];
  /** Requests to anything that is not the collector (the app's own fetches). */
  readonly app: Array<{ url: string; headers: Record<string, string> }> = [];
  private answers: Answer[] = [];
  private always: Answer | undefined;
  private pending: Promise<void>[] = [];
  /** Bumped by `reset`: bodies of an earlier test that finish decoding late are thrown away. */
  private epoch = 0;

  constructor(readonly base: string) {}

  /** The next request gets this answer (queue), then back to 200. */
  next(...answers: Answer[]): void {
    this.answers.push(...answers);
  }
  /** Every request gets this answer until cleared with `undefined`. */
  setAlways(answer: Answer | undefined): void {
    this.always = answer;
  }
  reset(): void {
    this.requests.length = this.logs.length = this.spans.length = this.replay.length = this.app.length = 0;
    this.answers = [];
    this.always = undefined;
    this.epoch++;
    this.pending = [];
  }
  events(name?: string): CapturedLog[] {
    return name ? this.logs.filter((l) => l.eventName === name) : this.logs;
  }
  /** Resolves when every captured body has been decoded. */
  async settled(): Promise<void> {
    await Promise.all(this.pending);
  }

  install(): void {
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
      if (!url.startsWith(this.base)) {
        this.app.push({ url, headers });
        return new Response("{}", { status: url.includes("/fail") ? 500 : 200, headers: { "content-type": "application/json" } });
      }
      const raw = init?.body;
      const body = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array();
      const answer = this.answers.shift() ?? this.always ?? {};
      if (answer.fail) throw new TypeError("Failed to fetch");
      const status = answer.status ?? 200;
      this.requests.push({ url, headers, body, keepalive: init?.keepalive === true });
      if (status >= 200 && status < 300) this.pending.push(this.decode(url, headers, body));
      return new Response(status === 204 ? null : (answer.body as BodyInit | undefined) ?? "{}", {
        status,
        headers: answer.retryAfter !== undefined ? { "retry-after": answer.retryAfter } : {},
      });
    };
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  private async decode(url: string, headers: Record<string, string>, body: Uint8Array): Promise<void> {
    const epoch = this.epoch;
    const plain = headers["content-encoding"] === "gzip" ? await gunzip(body) : body;
    if (epoch !== this.epoch) return;
    if (headers["content-type"] === "application/x-protobuf") {
      this.replay.push(...decodeProtoLogs(plain));
      return;
    }
    const doc = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    if (url.endsWith("/v1/logs")) {
      for (const rl of (doc["resourceLogs"] ?? []) as Array<Record<string, any>>) {
        for (const sl of rl["scopeLogs"] ?? []) {
          for (const lr of sl.logRecords ?? []) {
            this.logs.push({
              ...lr,
              eventName: lr.eventName ?? "",
              attributes: attrs(lr.attributes),
              body: lr.body ? value(lr.body) : undefined,
              scope: sl.scope?.name ?? "",
              schemaUrl: sl.schemaUrl ?? "",
              resource: attrs(rl["resource"]?.attributes),
            });
          }
        }
      }
    } else if (url.endsWith("/v1/traces")) {
      for (const rs of (doc["resourceSpans"] ?? []) as Array<Record<string, any>>) {
        for (const ss of rs["scopeSpans"] ?? []) {
          for (const sp of ss.spans ?? []) this.spans.push({ ...sp, attributes: attrs(sp.attributes), events: sp.events ?? [], scope: ss.scope?.name ?? "", schemaUrl: ss.schemaUrl ?? "" });
        }
      }
    }
  }
}

export const wait = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns something truthy, or fails after `timeoutMs`. */
export async function until<T>(fn: () => T | Promise<T>, timeoutMs = 2000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await wait(10);
  }
}
