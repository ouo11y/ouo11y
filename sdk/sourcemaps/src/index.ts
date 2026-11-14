// ouo-sourcemaps: debug ids into built bundles, maps and dSYMs up to Muninn (ADR-0011, ADR-0026,
// docs/sourcemaps.md, docs/symbolication.md).
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

/** One minified file and its source map. */
export interface Artifact {
  /** The bundle (absolute path): JavaScript text, or Hermes bytecode for a React Native bundle. */
  js: string;
  /** Its map (absolute path). */
  map: string;
  /**
   * The bundle's path relative to the scanned directory, "/" separated: the path the release
   * index keys on. A `.hbc` suffix is dropped (`index.android.bundle.hbc` ships as `index.android.bundle`).
   */
  rel: string;
}

// Web bundles, and React Native bundles: Metro writes `index.android.bundle` / `main.jsbundle`
// (JavaScript text), hermesc compiles them in place or to `<bundle>.hbc` (bytecode).
const JS = /\.(?:m|c)?js$|\.(?:jsbundle|bundle|hbc)$/;
const RN_BUNDLE = /\.(?:jsbundle|bundle|hbc)$/;

/** Whether a file name is a React Native bundle (Metro output, text or Hermes bytecode). */
export function isReactNativeBundle(file: string): boolean {
  return RN_BUNDLE.test(file);
}

// Hermes bytecode starts with this 8-byte magic (little-endian 0x1F1903C103BC1FC6).
const HBC_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

/** Whether the bytes are a Hermes bytecode bundle (which nothing can append to after hermesc). */
export function isHermesBytecode(b: Buffer): boolean {
  return b.length >= 8 && b.subarray(0, 8).equals(HBC_MAGIC);
}

// The debug id as the React Native snippet holds it: one string literal, which hermesc keeps
// byte for byte in the bytecode's string table. Sentry's snippet keeps `sentry-dbid-<uuid>`.
const OUO_MARKER = /ouo-debug-id:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const SENTRY_MARKER = /sentry-dbid-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/**
 * The debug id a React Native bundle carries in its registration snippet, read from the bundle
 * itself, text or Hermes bytecode: the composed Hermes map does not keep `debugId`, so this is
 * how an upload after `react-native bundle` + hermesc + compose knows it. Undefined when the
 * bundle has none, or two different ones (then nothing is guessed).
 */
export function markedDebugId(b: Buffer | string): string | undefined {
  const text = typeof b === "string" ? b : b.toString("latin1");
  for (const re of [OUO_MARKER, SENTRY_MARKER]) {
    const ids = new Set([...text.matchAll(re)].map((m) => m[1]!));
    if (ids.size === 1) return [...ids][0];
    if (ids.size > 1) return undefined;
  }
  return undefined;
}
// One trailing `//# debugId=` or `//# sourceMappingURL=` comment, at the end of the text. It may share
// the line with code: terser writes `...;//# sourceMappingURL=index.js.map` with no newline.
// No quotes or parentheses in the value, so `"//# debugId=x";f()` at the end of code is not one.
const trailingComment = /\/\/[#@] (debugId|sourceMappingURL)=([^\s'"`()]+)[ \t]*$/;

interface Trailing {
  /** The file without its trailing debugId / sourceMappingURL comments (and trailing whitespace). */
  body: string;
  debugId?: string;
  /** The sourceMappingURL value and the comment as written. */
  mappingUrl?: string;
  mappingComment?: string;
}

/** Splits the trailing debugId / sourceMappingURL comments off a bundle (either order, each once). */
export function splitTrailing(src: string): Trailing {
  const out: Trailing = { body: src.replace(/\s+$/, "") };
  for (let i = 0; i < 2; i++) {
    const m = out.body.match(trailingComment);
    if (!m) break;
    if (m[1] === "debugId") {
      if (out.debugId !== undefined) break;
      out.debugId = m[2]!.toLowerCase();
    } else {
      if (out.mappingUrl !== undefined) break;
      out.mappingUrl = m[2]!;
      out.mappingComment = m[0].trim();
    }
    out.body = out.body.slice(0, m.index).replace(/\s+$/, "");
  }
  return out;
}
// The snippet itself (not just the registry name: a bundle that includes @ouo11y/browser mentions it too).
const snippetLine = /^;!function\(\)\{try\{var g=.*__ouoDebugIds.*\}\(\);$/m;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") out.push(...(await walk(p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every bundle under dir that has a map: the one its `//# sourceMappingURL=` names (not a data:
 * URL), else `<file>.map` next to it (Vite `build.sourcemap: "hidden"`, webpack `hidden-source-map`).
 */
export async function findArtifacts(dir: string): Promise<Artifact[]> {
  const root = path.resolve(dir);
  const files = await walk(root);
  const present = new Set(files);
  const out: Artifact[] = [];
  for (const js of files.filter((f) => JS.test(f)).sort()) {
    // hermesc wrote `<bundle>.hbc` (+ `.hbc.map`) next to the JavaScript it compiled (hot-updater,
    // a hand-written pipeline): the bytecode is what ships, its map is the composed one.
    if (present.has(`${js}.hbc`) && present.has(`${js}.hbc.map`)) continue;
    const bytes = await readFile(js);
    const src = isHermesBytecode(bytes) ? "" : bytes.toString("utf8");
    const ref = splitTrailing(src).mappingUrl;
    let map: string | undefined;
    if (ref && !ref.startsWith("data:") && !/^[a-z]+:\/\//i.test(ref)) {
      const p = path.resolve(path.dirname(js), decodeURIComponent(ref.split(/[?#]/)[0] ?? ref));
      if (present.has(p)) map = p;
    }
    if (!map && present.has(`${js}.map`)) map = `${js}.map`;
    if (map) out.push({ js, map, rel: relOf(root, js) });
  }
  return out;
}

function relOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/").replace(/\.hbc$/, "");
}

/**
 * One bundle and its map given as files, for builds that write them to different folders:
 * the Android Gradle plugin (`build/generated/assets/...` and `build/generated/sourcemaps/...`),
 * Xcode (`main.jsbundle` in the app, `SOURCEMAP_FILE` elsewhere). `rel` is the bundle's file name.
 */
export function artifactOf(bundle: string, map: string): Artifact {
  const js = path.resolve(bundle);
  return { js, map: path.resolve(map), rel: relOf(path.dirname(js), js) };
}

/** A UUID (version 4 layout) derived from the map's bytes: the same output gets the same id. */
export function debugIdFor(content: string | Buffer): string {
  const h = createHash("sha256").update(content).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * The registration snippet: it finds its own script URL (the first URL of `new Error().stack`;
 * Firefox and Safari have no "Error" line) and registers `globalThis.__ouoDebugIds[url] = id`, which
 * `@ouo11y/browser` reads when it reports an exception. Doing the parsing here keeps it out of the
 * SDK's bundle. No eval, safe under a strict CSP, never throws.
 */
export function snippet(id: string): string {
  return (
    ';!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},' +
    "u=((new Error).stack||\"\").match(/\\w+:\\/\\/[^\\s()'\"]+?(?=:\\d+:\\d+|\\)|\\s|$)/);" +
    `u&&((g.__ouoDebugIds=g.__ouoDebugIds||{})[u[0]]="${id}")}catch(e){}}();`
  );
}

/**
 * The React Native registration snippet. Hermes stacks name files, not URLs (`address at
 * index.android.bundle:1:123`, `/data/user/0/<app>/files/.../index.android.bundle`,
 * `.../App.app/main.jsbundle`), so it takes the file of the first frame, whatever its form, and
 * registers `globalThis.__ouoDebugIds[file] = id`; `@ouo11y/react-native` normalises the key the
 * way it normalises the stack. The id is one string literal with an `ouo-debug-id:` prefix, so it
 * survives Hermes compilation verbatim and `markedDebugId` can read it from the bytecode. One
 * line, no eval, never throws.
 */
export function reactNativeSnippet(id: string): string {
  return (
    ';!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof global?global:{},' +
    `d="ouo-debug-id:${id}".slice(13),s=(new Error).stack||"",` +
    "m=s.match(/\\((?:address at )?([^()]+?):\\d+:\\d+\\)|@([^\\s@()]+?):\\d+:\\d+|at ([^\\s()]+?):\\d+:\\d+/);" +
    '(g.__ouoDebugIds=g.__ouoDebugIds||{})[m?m[1]||m[2]||m[3]:"unknown"]=d}catch(e){}}();'
  );
}

export interface InjectResult {
  artifact: Artifact;
  debugId: string;
  /** False when the bundle already had a debug id (inject is idempotent). */
  changed: boolean;
}

/**
 * Appends the snippet and `//# debugId=` to the bundle and sets `debugId` in its map. The snippet
 * goes after the last line of code, so no existing mapping moves; `//# sourceMappingURL=` stays last.
 *
 * React Native bundles (`.bundle`, `.jsbundle`, or `reactNative: true`) get the React Native
 * snippet. Inject them after Metro and before hermesc; a bundle that is Hermes bytecode already
 * cannot change, so only its map is updated when the bundle carries an id (the Metro serializer,
 * `@ouo11y/sourcemaps/metro`, wrote it), and it is an error otherwise.
 */
export async function inject(a: Artifact, opts: { dryRun?: boolean; reactNative?: boolean } = {}): Promise<InjectResult> {
  const bytes = await readFile(a.js);
  const mapText = await readFile(a.map, "utf8");
  const map = JSON.parse(mapText) as Record<string, unknown>;
  const mapId = typeof map["debugId"] === "string" ? map["debugId"].toLowerCase() : undefined;
  const writeMapId = async (id: string): Promise<void> => {
    if (map["debugId"] === id || opts.dryRun) return;
    map["debugId"] = id;
    map["debug_id"] = id;
    await writeFile(a.map, JSON.stringify(map));
  };
  if (isHermesBytecode(bytes)) {
    const id = markedDebugId(bytes);
    if (!id) {
      throw new Error(
        `${a.rel} is Hermes bytecode without a debug id: inject the JavaScript bundle before hermesc, or add withOuoDebugIds to metro.config.js`,
      );
    }
    await writeMapId(id);
    return { artifact: a, debugId: id, changed: false };
  }
  const src = bytes.toString("utf8");
  const rn = opts.reactNative ?? isReactNativeBundle(a.js);
  // A bundler may have written the debug id already (Rollup / Vite `sourcemapDebugIds`, the
  // Metro serializer): keep it, add only what is missing.
  const trailing = splitTrailing(src);
  const marked = rn ? markedDebugId(src) : undefined;
  const existing = trailing.debugId && /^[0-9a-f-]{32,36}$/.test(trailing.debugId) ? trailing.debugId : marked;
  const id = existing ?? mapId ?? debugIdFor(mapText);
  const hasSnippet = rn ? marked === id : snippetLine.test(src);
  if (existing && hasSnippet && trailing.debugId === id) {
    await writeMapId(id);
    return { artifact: a, debugId: id, changed: false };
  }
  // Code stays on its lines (a comment that shared the last line with code is cut off it, which
  // moves no mapping); the snippet and the comments go on new lines after it.
  const tail = trailing.mappingComment ? [trailing.mappingComment] : [];
  const code = hasSnippet ? "" : rn ? reactNativeSnippet(id) : snippet(id);
  const out = [trailing.body, code, `//# debugId=${id}`, ...tail].filter(Boolean).join("\n") + "\n";
  if (!opts.dryRun) {
    await writeFile(a.js, out);
    await writeMapId(id);
  }
  return { artifact: a, debugId: id, changed: true };
}

/**
 * The debug id of an artifact: the map's `debugId`, else the bundle's `//# debugId=`, else the
 * id the React Native snippet holds (read from the text or the Hermes bytecode).
 */
export async function debugIdOf(a: Artifact, mapText?: string): Promise<string | undefined> {
  const map = JSON.parse(mapText ?? (await readFile(a.map, "utf8"))) as Record<string, unknown>;
  for (const k of ["debugId", "debug_id"]) {
    const v = map[k];
    if (typeof v === "string" && v !== "") return v.toLowerCase();
  }
  const bytes = await readFile(a.js);
  if (!isHermesBytecode(bytes)) {
    const id = splitTrailing(bytes.toString("utf8")).debugId;
    if (id) return id;
  }
  return markedDebugId(bytes);
}

export interface UploadOptions {
  /** Muninn's public base URL, e.g. https://muninn.example.com. */
  url: string;
  /** The project's upload token (secret; never the public ingest token). */
  token: string;
  /** The project the files belong to: the upload route names it, and the token must be this project's. */
  project: string;
  /** service.version of the build: indexes each map by release + URL path too. */
  release?: string;
  /** URL path the scanned directory is served under (default "/"): "/static/" for /static/js/a.js. */
  urlPrefix?: string;
  fetch?: typeof globalThis.fetch;
}

export interface UploadResult {
  artifact: Artifact;
  file: string;
  debugId?: string;
  /** True when the map had no debug id and the id was derived from its bytes (needs a release). */
  derived?: boolean;
  /** 201 stored, 200 already stored with the same content. */
  status: number;
  error?: string;
}

/** URL path of an artifact as the browser loads it. */
export function urlPathOf(a: Artifact, prefix = "/"): string {
  const p = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return (p.endsWith("/") ? p : `${p}/`) + a.rel;
}

/**
 * PUTs one map (gzip) to Muninn as debug file kind `sourcemap`, keyed by its debug id, with the
 * release and the script's URL path when a release is given (docs/specs/muninn.md 13.2). A map
 * without a debug id gets one derived from its bytes, which only a release + path lookup finds.
 */
export async function upload(a: Artifact, o: UploadOptions): Promise<UploadResult> {
  const mapBytes = await readFile(a.map);
  const file = urlPathOf(a, o.urlPrefix);
  let debugId = await debugIdOf(a, mapBytes.toString("utf8"));
  const derived = !debugId;
  if (!debugId) {
    if (!o.release) return { artifact: a, file, status: 0, error: "no debug id (run `ouo-sourcemaps inject` first) and no --release" };
    debugId = debugIdFor(mapBytes);
  }
  const q = new URLSearchParams();
  if (o.release) {
    q.set("release", o.release);
    q.set("file", file);
  }
  const r = await put(o, "sourcemap", debugId, q, "application/json", gzipSync(mapBytes));
  return { artifact: a, file, debugId, ...(derived ? { derived } : {}), status: r.status, ...(r.error ? { error: r.error } : {}) };
}

/**
 * PUTs a gzip body to `<url>/api/v1/projects/<project>/debug-files/<kind>/<id>` with the upload
 * token. 201 (stored) and 200 (already stored, same content) succeed; anything else sets error.
 */
async function put(
  o: UploadOptions,
  kind: "sourcemap" | "dsym",
  id: string,
  q: URLSearchParams,
  contentType: string,
  body: Buffer,
): Promise<{ status: number; error?: string }> {
  if (!o.project) return { status: 0, error: "no project (--project or OUO_PROJECT_ID)" };
  const doFetch = o.fetch ?? globalThis.fetch;
  const qs = q.size > 0 ? `?${q}` : "";
  const target = `${o.url.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(o.project)}/debug-files/${kind}/${id}${qs}`;
  try {
    const res = await doFetch(target, {
      method: "PUT",
      headers: { authorization: `Bearer ${o.token}`, "content-type": contentType, "content-encoding": "gzip" },
      body,
    });
    let err: string | undefined;
    try {
      err = ((await res.json()) as { error?: string } | undefined)?.error;
    } catch {
      // not JSON
    }
    if (res.status === 201 || res.status === 200) return { status: res.status };
    if (res.status === 409) {
      return { status: 409, error: `HTTP 409: ${kind} ${id} is already stored with different content (debug files are write-once)` };
    }
    return { status: res.status, error: `HTTP ${res.status}${err ? `: ${err}` : ""}` };
  } catch (e) {
    return { status: 0, error: String(e) };
  }
}

const DWARF_FILE = /\.dSYM[\\/]Contents[\\/]Resources[\\/]DWARF[\\/][^\\/]+$/;

/**
 * The DWARF files to upload for a path: the path itself when it is a file, else every
 * `<name>.dSYM/Contents/Resources/DWARF/<binary>` under it (a .dSYM bundle, an Xcode archive's
 * dSYMs folder, a build products folder).
 */
export async function findDSYMs(p: string): Promise<string[]> {
  const abs = path.resolve(p);
  if ((await stat(abs)).isFile()) return [abs];
  return (await walk(abs)).filter((f) => DWARF_FILE.test(f)).sort();
}

/** One architecture slice of a Mach-O file. */
export interface MachOSlice {
  /** Its LC_UUID, lowercase with dashes: the debug id of the binary image in a crash report. */
  uuid: string;
  arch: string;
  data: Buffer;
}

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_UUID = 0x1b;

/**
 * The architecture slices of a Mach-O file (a dSYM's DWARF file), each with its LC_UUID: the
 * slices of a universal (fat, fat64) file, or the file itself when it is thin (32 or 64-bit,
 * either byte order). Throws when the bytes are not Mach-O or a slice has no LC_UUID.
 */
export function machoSlices(b: Buffer): MachOSlice[] {
  if (b.length < 8) throw new Error("not a Mach-O file");
  const magic = b.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return [thinSlice(b)];
  // Fat headers are big-endian: magic, nfat_arch, then fat_arch (20 bytes) or fat_arch_64 (32).
  const is64 = magic === FAT_MAGIC_64;
  const n = b.readUInt32BE(4);
  const entry = is64 ? 32 : 20;
  if (n === 0 || 8 + n * entry > b.length) throw new Error("not a Mach-O file: truncated universal header");
  const out: MachOSlice[] = [];
  for (let i = 0; i < n; i++) {
    const h = 8 + i * entry;
    const offset = is64 ? Number(b.readBigUInt64BE(h + 8)) : b.readUInt32BE(h + 8);
    const size = is64 ? Number(b.readBigUInt64BE(h + 16)) : b.readUInt32BE(h + 12);
    if (offset + size > b.length) throw new Error("not a Mach-O file: truncated universal file");
    out.push(thinSlice(b.subarray(offset, offset + size)));
  }
  return out;
}

function thinSlice(b: Buffer): MachOSlice {
  if (b.length < 28) throw new Error("not a Mach-O file");
  let le: boolean;
  if (b.readUInt32LE(0) === MH_MAGIC || b.readUInt32LE(0) === MH_MAGIC_64) le = true;
  else if (b.readUInt32BE(0) === MH_MAGIC || b.readUInt32BE(0) === MH_MAGIC_64) le = false;
  else throw new Error("not a Mach-O file");
  const u32 = (o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const is64 = u32(0) === MH_MAGIC_64;
  const cpu = u32(4);
  const arch = archName(cpu);
  const ncmds = u32(16);
  let at = is64 ? 32 : 28;
  for (let i = 0; i < ncmds && at + 8 <= b.length; i++) {
    const cmd = u32(at);
    const size = u32(at + 4);
    if (cmd === LC_UUID && size >= 24 && at + 24 <= b.length) {
      const x = b.subarray(at + 8, at + 24).toString("hex");
      const uuid = `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
      return { uuid, arch, data: b };
    }
    if (size < 8) break;
    at += size;
  }
  throw new Error(`no LC_UUID in the ${arch} slice`);
}

function archName(cpu: number): string {
  switch (cpu) {
    case 0x0100000c:
      return "arm64";
    case 0x0200000c:
      return "arm64_32";
    case 0x01000007:
      return "x86_64";
    case 7:
      return "i386";
    case 12:
      return "arm";
  }
  return `cpu${cpu}`;
}

export interface DSYMResult {
  file: string;
  /** The status of the last slice PUT (0 when the file could not be read as Mach-O). */
  status: number;
  /** The slices stored (or already stored), one per architecture, keyed by LC_UUID. */
  dsyms?: { debug_id: string; arch: string }[];
  error?: string;
}

/**
 * Splits one DWARF file into its Mach-O slices and PUTs each, gzip-compressed, to Muninn as debug
 * file kind `dsym` under its LC_UUID, with the release as metadata when given.
 */
export async function uploadDSYM(file: string, o: UploadOptions): Promise<DSYMResult> {
  let slices: MachOSlice[];
  try {
    slices = machoSlices(await readFile(file));
  } catch (e) {
    return { file, status: 0, error: (e as Error).message };
  }
  const q = new URLSearchParams();
  if (o.release) q.set("release", o.release);
  const dsyms: { debug_id: string; arch: string }[] = [];
  const errors: string[] = [];
  let status = 0;
  for (const s of slices) {
    const r = await put(o, "dsym", s.uuid, q, "application/octet-stream", gzipSync(s.data));
    status = r.status;
    if (r.error) errors.push(`${s.arch}: ${r.error}`);
    else dsyms.push({ debug_id: s.uuid, arch: s.arch });
  }
  return { file, status, dsyms, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
}

/** Deletes the maps so they are never deployed (and drops the bundles' sourceMappingURL lines). */
export async function deleteMaps(artifacts: Artifact[]): Promise<void> {
  for (const a of artifacts) {
    const bytes = await readFile(a.js);
    if (isHermesBytecode(bytes)) {
      await rm(a.map, { force: true });
      continue;
    }
    const src = bytes.toString("utf8");
    const t = splitTrailing(src);
    const stripped = t.mappingComment ? `${t.body}${t.debugId ? `\n//# debugId=${t.debugId}` : ""}\n` : src;
    if (stripped !== src) await writeFile(a.js, stripped);
    await rm(a.map, { force: true });
  }
}

/**
 * Composes Metro's map (bundle -> sources) with hermesc's (bytecode -> bundle) into the map of
 * the bytecode, as React Native's `compose-source-maps.js` does, with the app's own
 * `metro-source-map` (resolved from `cwd`, so no copy of Metro ships with this CLI). Keeps the
 * debug id of the packager map, or the one `bundle` carries.
 */
export async function composeHermesMaps(packagerMap: string, hermesMap: string, out: string, opts: { cwd?: string; bundle?: string } = {}): Promise<{ debugId?: string }> {
  const req = createRequire(path.join(path.resolve(opts.cwd ?? process.cwd()), "package.json"));
  let compose: (maps: unknown[]) => Record<string, unknown>;
  try {
    compose = (req("metro-source-map") as { composeSourceMaps: typeof compose }).composeSourceMaps;
  } catch {
    // metro-source-map is a dependency of react-native, not always hoisted.
    const rn = path.dirname(req.resolve("react-native/package.json"));
    compose = (createRequire(path.join(rn, "package.json"))("metro-source-map") as { composeSourceMaps: typeof compose }).composeSourceMaps;
  }
  const packager = JSON.parse(await readFile(packagerMap, "utf8")) as Record<string, unknown>;
  const hermes = JSON.parse(await readFile(hermesMap, "utf8")) as Record<string, unknown>;
  const composed = compose([packager, hermes]);
  let id = [packager["debugId"], packager["debug_id"], hermes["debugId"]].find((v): v is string => typeof v === "string" && v !== "");
  if (!id && opts.bundle) id = markedDebugId(await readFile(opts.bundle));
  if (id) {
    composed["debugId"] = id.toLowerCase();
    composed["debug_id"] = id.toLowerCase();
  }
  await writeFile(out, JSON.stringify(composed));
  return id ? { debugId: id.toLowerCase() } : {};
}
