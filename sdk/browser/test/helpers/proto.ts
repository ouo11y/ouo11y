/** A minimal protobuf reader, enough to decode an OTLP logs request (replay chunks). No dependencies: the unit tests and the browser e2e harness share it. */
export interface ReplayRecord {
  eventName: string;
  attributes: Record<string, unknown>;
  body: Uint8Array | undefined;
  scope: string;
  schemaUrl: string;
}

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

