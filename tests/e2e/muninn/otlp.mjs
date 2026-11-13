// A minimal OTLP logs protobuf encoder (ExportLogsServiceRequest) and response decoder,
// enough to send replay records the way an SDK does without a protobuf dependency.
// Field numbers: opentelemetry-proto logs/v1, common/v1, collector/logs/v1.
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
const tag = (field, wire) => varint((field << 3) | wire);
const len = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const str = (field, s) => len(field, Buffer.from(s, "utf8"));
function fixed64(field, n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return Buffer.concat([tag(field, 1), b]);
}

function anyValue(v) {
  if (typeof v === "string") return str(1, v);
  if (typeof v === "boolean") return Buffer.concat([tag(2, 0), varint(v ? 1 : 0)]);
  if (typeof v === "number" || typeof v === "bigint") return Buffer.concat([tag(3, 0), varint(v)]);
  if (Buffer.isBuffer(v)) return len(7, v);
  throw new Error(`unsupported value ${v}`);
}
const keyValue = (k, v) => Buffer.concat([str(1, k), len(2, anyValue(v))]);
const attributes = (field, attrs) => Buffer.concat(Object.entries(attrs).map(([k, v]) => len(field, keyValue(k, v))));

/**
 * One ExportLogsServiceRequest: resource attributes, scope name, records
 * [{ event, attrs, body?: Buffer, timeNs? }].
 */
export function logsRequest({ resource = {}, scope = "ouo.replay", records }) {
  const lrs = records.map((r) => {
    const parts = [fixed64(1, r.timeNs ?? BigInt(Date.now()) * 1_000_000n)];
    if (r.body) parts.push(len(5, anyValue(r.body)));
    parts.push(attributes(6, r.attrs));
    parts.push(str(12, r.event));
    return len(2, Buffer.concat(parts));
  });
  const scopeLogs = len(2, Buffer.concat([len(1, str(1, scope)), ...lrs]));
  const resourceLogs = Buffer.concat([len(1, attributes(1, resource)), scopeLogs]);
  return len(1, resourceLogs);
}

/** ExportLogsServiceResponse -> { rejected, message }. */
export function decodeResponse(buf) {
  const out = { rejected: 0, message: "" };
  const read = (b, onField) => {
    let i = 0;
    const vi = () => {
      let r = 0n, s = 0n;
      for (;;) {
        const x = b[i++];
        r |= BigInt(x & 0x7f) << s;
        if (!(x & 0x80)) return r;
        s += 7n;
      }
    };
    while (i < b.length) {
      const t = Number(vi());
      const f = t >> 3, w = t & 7;
      if (w === 0) onField(f, vi());
      else if (w === 2) { const n = Number(vi()); onField(f, b.subarray(i, i + n)); i += n; }
      else if (w === 1) i += 8;
      else if (w === 5) i += 4;
    }
  };
  read(buf, (f, v) => {
    if (f === 1) read(v, (g, x) => { if (g === 1) out.rejected = Number(x); if (g === 2) out.message = Buffer.from(x).toString("utf8"); });
  });
  return out;
}

export const hex = (n) => randomBytes(n).toString("hex");
export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** A valid ouo.replay.chunk record; override any attribute with `over` (null deletes). */
export function chunkRecord({ session, replay, stream, seq, format = "rrweb/2", body, over = {} }) {
  body ??= gzipSync(Buffer.from(JSON.stringify({ type: 3, data: { seq }, timestamp: Date.now() }) + "\n"));
  const attrs = {
    "session.id": session, "ouo.replay.id": replay, "ouo.replay.stream.id": stream,
    "ouo.replay.sequence": seq, "ouo.replay.segment.index": 0, "ouo.replay.keyframe": seq === 0,
    "ouo.replay.start_time": Date.now() - 1000, "ouo.replay.end_time": Date.now(),
    "ouo.replay.format": format, "ouo.replay.encoding": "gzip", "ouo.replay.sha256": sha256(body),
    "ouo.replay.byte_size": body.length, "ouo.replay.masked": true, "ouo.replay.mode": "session",
  };
  for (const [k, v] of Object.entries(over)) if (v === null) delete attrs[k]; else attrs[k] = v;
  return { event: "ouo.replay.chunk", attrs, body };
}
