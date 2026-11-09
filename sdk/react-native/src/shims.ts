/**
 * Globals the bundled OTel browser builds rely on that React Native / Hermes may lack.
 * Everything here is idempotent and only fills gaps; it never replaces a working global.
 * See project/kb-archive/otel-react-native.md for the list and why each one is needed.
 */
export interface ShimReport {
  performance: "native" | "timeOrigin-added" | "polyfilled";
  textEncoder: "native" | "polyfilled";
}

type PerfLike = { now(): number; timeOrigin?: number };

function installPerformance(): ShimReport["performance"] {
  const g = globalThis as { performance?: PerfLike };
  const start = Date.now();
  if (!g.performance || typeof g.performance.now !== "function") {
    g.performance = { now: () => Date.now() - start, timeOrigin: start };
    return "polyfilled";
  }
  const origin = g.performance.timeOrigin;
  if (typeof origin === "number" && Number.isFinite(origin) && origin > 0) return "native";
  // @opentelemetry/core's hrTime() adds performance.timeOrigin to performance.now(); without a
  // numeric origin every span timestamp becomes NaN and the collector rejects the batch.
  const computed = Date.now() - g.performance.now();
  try {
    Object.defineProperty(g.performance, "timeOrigin", { value: computed, configurable: true, writable: true });
    if (g.performance.timeOrigin === computed) return "timeOrigin-added";
  } catch {
    // non-configurable host object: fall through to a wrapper
  }
  const native = g.performance;
  g.performance = { now: () => native.now(), timeOrigin: computed };
  return "polyfilled";
}

/** Minimal UTF-8 TextEncoder (encode only) for the OTLP JSON serializer. */
class Utf8Encoder {
  readonly encoding = "utf-8";
  encode(input = ""): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      let cp = input.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < input.length) {
        const low = input.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
          i++;
        }
      }
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return Uint8Array.from(out);
  }
}

function installTextEncoder(): ShimReport["textEncoder"] {
  const g = globalThis as { TextEncoder?: unknown };
  if (typeof g.TextEncoder === "function") return "native";
  g.TextEncoder = Utf8Encoder;
  return "polyfilled";
}

let report: ShimReport | undefined;

/** Installs the shims once and returns what was needed. */
export function installShims(): ShimReport {
  if (!report) report = { performance: installPerformance(), textEncoder: installTextEncoder() };
  return report;
}
