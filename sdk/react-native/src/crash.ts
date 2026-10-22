import type { DebugLogger } from "./logger";
import { loadNativeReplayModule } from "./replay";
import type { CrashMarker } from "./session/manager";
import type { Attrs } from "./types";

/**
 * Native crash capture (checklist G1). The Expo module's OuoCrash handlers (sdk/ios
 * Sources/OuoCrash*) write one JSON report at crash time; the next `initRUM` takes it, ends the
 * crashed session with reason `crash` at the crash time and emits a fatal `exception` for it
 * (ADR-0004: the session is `crashed`). Report format: project/kb/ios-native-crashes.md.
 */
export interface NativeCrashModule {
  installCrashReporter?(sessionId: string): boolean;
  setCrashSessionId?(id: string): void;
  takePendingCrash?(): string | null | undefined;
}

export interface NativeCrashFrame {
  instruction_addr: string;
  image_addr?: string;
}

export interface NativeCrashImage {
  code_file: string;
  debug_id?: string;
  image_addr: string;
  image_size: number;
  image_vmaddr: string;
}

export interface NativeCrashReport {
  version: number;
  mechanism: "signal" | "nsexception";
  timestamp_ms: number;
  session_id: string;
  arch?: string;
  thread?: { main?: boolean };
  signal?: { number: number; name: string; mach_exception?: string; code?: number; code_name?: string; address?: string };
  exception?: { name: string; reason: string };
  frames: NativeCrashFrame[];
  images: NativeCrashImage[];
}

export function parseNativeCrash(raw: string): NativeCrashReport | undefined {
  try {
    const r = JSON.parse(raw) as Partial<NativeCrashReport>;
    if (!r || typeof r !== "object") return undefined;
    if (r.mechanism !== "signal" && r.mechanism !== "nsexception") return undefined;
    if (typeof r.timestamp_ms !== "number") return undefined;
    return {
      ...r,
      version: typeof r.version === "number" ? r.version : 1,
      mechanism: r.mechanism,
      timestamp_ms: r.timestamp_ms,
      session_id: typeof r.session_id === "string" ? r.session_id : "",
      frames: Array.isArray(r.frames) ? r.frames.filter((f) => f && typeof f.instruction_addr === "string") : [],
      images: Array.isArray(r.images) ? r.images.filter((i) => i && typeof i.image_addr === "string") : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * React Native turns a JS fatal into `RCTFatalException: <message>` in Release builds. The JS
 * global handler already emitted that error (with its JS stack) and wrote the JS crash marker, so
 * the native report only supplies the end time.
 */
export function isReactNativeFatal(report: NativeCrashReport): boolean {
  return report.mechanism === "nsexception" && (report.exception?.name ?? "").startsWith("RCTFatalException");
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

function hexToBigInt(h: string | undefined): bigint | undefined {
  if (!h || !/^0x[0-9a-f]+$/i.test(h)) return undefined;
  try {
    return BigInt(h);
  } catch {
    return undefined;
  }
}

function crashTitle(r: NativeCrashReport): { type: string; message: string } {
  if (r.mechanism === "nsexception") {
    const name = r.exception?.name || "NSException";
    return { type: name, message: r.exception?.reason ?? "" };
  }
  const s = r.signal;
  const name = s?.name ?? "signal";
  const parts = [`${s?.mach_exception ?? "EXC_CRASH"} (${name})`];
  if (s?.code_name) parts.push(s.code_name);
  if (s?.address && (name === "SIGSEGV" || name === "SIGBUS")) parts.push(`at ${s.address}`);
  return { type: name, message: parts.join(" ") };
}

/**
 * Apple crash report style, so it reads without symbols and `atos -o <dSYM> -l <image_addr>
 * <instruction_addr>` works line by line:
 *   0   sentrydemo   0x0000000104a1c2f0 0x104a00000 + 115440
 */
export function formatNativeStack(r: NativeCrashReport): string {
  const { type, message } = crashTitle(r);
  const images = new Map(r.images.map((i) => [i.image_addr, i]));
  const thread = r.thread?.main === true ? "main thread" : r.thread?.main === false ? "background thread" : "crashed thread";
  const lines = [`${type}: ${message}`.trim(), `Thread (${thread}) crashed${r.arch ? `, ${r.arch}` : ""}:`];
  r.frames.forEach((f, i) => {
    const img = f.image_addr ? images.get(f.image_addr) : undefined;
    const name = img ? basename(img.code_file) : "???";
    const addr = hexToBigInt(f.instruction_addr);
    const base = hexToBigInt(f.image_addr);
    const offset = addr !== undefined && base !== undefined ? ` ${f.image_addr} + ${(addr - base).toString()}` : "";
    const padded = addr !== undefined ? `0x${addr.toString(16).padStart(16, "0")}` : f.instruction_addr;
    lines.push(`${String(i).padEnd(4)}${name.padEnd(32)}${padded}${offset}`);
  });
  if (r.images.length > 0) {
    lines.push("", "Binary Images:");
    for (const img of r.images) {
      const start = hexToBigInt(img.image_addr);
      const end = start !== undefined ? `0x${(start + BigInt(Math.max(0, img.image_size - 1))).toString(16)}` : "?";
      lines.push(`${img.image_addr} - ${end} ${basename(img.code_file)} ${r.arch ?? ""} <${(img.debug_id ?? "").toLowerCase()}> ${img.code_file}`);
    }
  }
  return lines.join("\n");
}

/** `exception` event attributes (session-lifecycle spec) plus what symbolication needs later. */
export function nativeCrashAttributes(r: NativeCrashReport): Attrs {
  const { type, message } = crashTitle(r);
  const attrs: Attrs = {
    "exception.type": type,
    "exception.message": message,
    "exception.stacktrace": formatNativeStack(r),
    "ouo.exception.fatal": true,
    "ouo.exception.handled": false,
    "ouo.exception.kind": "native",
    "ouo.crash.mechanism": r.mechanism,
    "ouo.crash.timestamp": r.timestamp_ms,
    // Symbolication inputs, kept verbatim: instruction_addr / image_addr per frame, and every
    // binary image a frame points into (code_file, debug_id = LC_UUID, image_addr, image_size,
    // image_vmaddr), the field names Sentry's debug_meta uses.
    "ouo.crash.frames": JSON.stringify(r.frames),
    "ouo.crash.images": JSON.stringify(r.images),
  };
  if (r.session_id) attrs["session.id"] = r.session_id;
  if (r.arch) attrs["ouo.crash.arch"] = r.arch;
  if (r.signal) {
    attrs["ouo.crash.signal"] = r.signal.name;
    if (r.signal.mach_exception) attrs["ouo.crash.mach_exception"] = r.signal.mach_exception;
    if (r.signal.address) attrs["ouo.crash.address"] = r.signal.address;
  }
  if (r.thread?.main !== undefined) attrs["ouo.crash.thread_main"] = r.thread.main;
  return attrs;
}

/** The session manager's crash marker for the crashed session: its end time is the crash time. */
export function crashMarker(r: NativeCrashReport): CrashMarker {
  const { type, message } = crashTitle(r);
  return { sessionId: r.session_id, at: r.timestamp_ms, type, message: message.slice(0, 500) };
}

export interface NativeCrashCapture {
  readonly active: boolean;
  /** The previous run's report, taken once at creation. */
  readonly pending: NativeCrashReport | undefined;
  install(sessionId: string): void;
  setSessionId(id: string): void;
}

export interface NativeCrashCaptureOptions {
  enabled: boolean;
  logger: DebugLogger;
  /** Injected for tests; `undefined` loads the Expo module, `null` means absent. */
  native?: NativeCrashModule | null;
}

export function createNativeCrashCapture(opts: NativeCrashCaptureOptions): NativeCrashCapture {
  const { logger } = opts;
  const native: NativeCrashModule | undefined = opts.enabled
    ? opts.native === undefined
      ? (loadNativeReplayModule() as NativeCrashModule | undefined)
      : opts.native ?? undefined
    : undefined;
  // Older native builds of the module have no crash functions: nothing to do.
  const installNative = native && typeof native.installCrashReporter === "function" ? native.installCrashReporter.bind(native) : undefined;
  const supported = installNative !== undefined;
  let active = false;
  let pending: NativeCrashReport | undefined;
  if (supported) {
    try {
      const raw = native?.takePendingCrash?.();
      if (typeof raw === "string" && raw.length > 0) {
        pending = parseNativeCrash(raw);
        if (!pending) logger.warn("native crash: unreadable report dropped");
      }
    } catch (err) {
      logger.warn("native crash: takePendingCrash failed", err);
    }
  } else if (opts.enabled) {
    logger.log("native crash capture unavailable (no native module with installCrashReporter)");
  }
  return {
    get active() {
      return active;
    },
    pending,
    install(sessionId: string): void {
      if (!supported || active) return;
      try {
        active = installNative!(sessionId) !== false;
        logger.log("native crash capture installed", active);
      } catch (err) {
        logger.warn("native crash: install failed", err);
      }
    },
    setSessionId(id: string): void {
      if (!active) return;
      try {
        native?.setCrashSessionId?.(id);
      } catch (err) {
        logger.warn("native crash: setCrashSessionId failed", err);
      }
    },
  };
}
