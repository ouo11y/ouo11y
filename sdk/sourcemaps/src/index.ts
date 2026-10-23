// ouo-sourcemaps: debug ids into built bundles, maps up to rum-api (ADR-0011, docs/sourcemaps.md).
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

/** One minified file and its source map. */
export interface Artifact {
  /** The bundle (absolute path). */
  js: string;
  /** Its map (absolute path). */
  map: string;
  /** The bundle's path relative to the scanned directory, "/" separated. */
  rel: string;
}

const JS = /\.(?:m|c)?js$/;
const debugIdComment = /^\/\/# debugId=([0-9a-fA-F-]{32,36})\s*$/m;
const mappingUrlComment = /^\/\/[#@] sourceMappingURL=(\S+)\s*$/m;

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
    const src = await readFile(js, "utf8");
    const ref = src.match(mappingUrlComment)?.[1];
    let map: string | undefined;
    if (ref && !ref.startsWith("data:") && !/^[a-z]+:\/\//i.test(ref)) {
      const p = path.resolve(path.dirname(js), decodeURIComponent(ref.split(/[?#]/)[0] ?? ref));
      if (present.has(p)) map = p;
    }
    if (!map && present.has(`${js}.map`)) map = `${js}.map`;
    if (map) out.push({ js, map, rel: path.relative(root, js).split(path.sep).join("/") });
  }
  return out;
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
 * The registration snippet: the SDK reads `globalThis.__ouoDebugIds` (stack of this line -> id) to
 * learn which debug id each loaded script has. No eval, safe under a strict CSP, never throws.
 */
export function snippet(id: string): string {
  return (
    ';!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},' +
    `s=(new Error).stack;s&&((g.__ouoDebugIds=g.__ouoDebugIds||{})[s]="${id}")}catch(e){}}();`
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
 */
export async function inject(a: Artifact, opts: { dryRun?: boolean } = {}): Promise<InjectResult> {
  const src = await readFile(a.js, "utf8");
  const mapText = await readFile(a.map, "utf8");
  const map = JSON.parse(mapText) as Record<string, unknown>;
  // A bundler may have written the debug id already (Rollup / Vite `sourcemapDebugIds`): keep it,
  // add only what is missing.
  const existing = src.match(debugIdComment)?.[1]?.toLowerCase();
  const id = existing ?? (typeof map["debugId"] === "string" ? map["debugId"].toLowerCase() : debugIdFor(mapText));
  const hasSnippet = src.includes("__ouoDebugIds");
  if (existing && hasSnippet) {
    if (map["debugId"] !== id && !opts.dryRun) {
      map["debugId"] = id;
      map["debug_id"] = id;
      await writeFile(a.map, JSON.stringify(map));
    }
    return { artifact: a, debugId: id, changed: false };
  }
  let body = src;
  const tail: string[] = [];
  for (const re of [debugIdComment, mappingUrlComment]) {
    const m = body.match(re);
    if (m) {
      body = body.slice(0, m.index) + body.slice(m.index! + m[0].length);
      if (re === mappingUrlComment) tail.push(m[0].trim());
    }
  }
  body = body.replace(/\s*$/, "");
  const out = [body, hasSnippet ? "" : snippet(id), `//# debugId=${id}`, ...tail].filter(Boolean).join("\n") + "\n";
  if (!opts.dryRun) {
    await writeFile(a.js, out);
    map["debugId"] = id;
    map["debug_id"] = id;
    await writeFile(a.map, JSON.stringify(map));
  }
  return { artifact: a, debugId: id, changed: true };
}

export interface UploadOptions {
  /** rum-api base URL, e.g. http://rum-api:8080. */
  url: string;
  /** The project's upload token (secret; never the public ingest token). */
  token: string;
  /** Checked against the token's project by rum-api when set. */
  project?: string;
  /** service.version of the build: indexes the map by release + URL path too. */
  release?: string;
  /** URL path the scanned directory is served under (default "/"): "/static/" for /static/js/a.js. */
  urlPrefix?: string;
  fetch?: typeof globalThis.fetch;
}

export interface UploadResult {
  artifact: Artifact;
  file: string;
  debugId?: string;
  status: number;
  error?: string;
}

/** URL path of an artifact as the browser loads it. */
export function urlPathOf(a: Artifact, prefix = "/"): string {
  const p = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return (p.endsWith("/") ? p : `${p}/`) + a.rel;
}

/** PUTs one map (gzip) to rum-api's /v1/sourcemaps. */
export async function upload(a: Artifact, o: UploadOptions): Promise<UploadResult> {
  const mapText = await readFile(a.map, "utf8");
  const map = JSON.parse(mapText) as Record<string, unknown>;
  const src = await readFile(a.js, "utf8");
  const debugId = (typeof map["debugId"] === "string" ? map["debugId"] : src.match(debugIdComment)?.[1])?.toLowerCase();
  const file = urlPathOf(a, o.urlPrefix);
  if (!debugId && !o.release) {
    return { artifact: a, file, status: 0, error: "no debug id (run `ouo-sourcemaps inject` first) and no --release" };
  }
  const q = new URLSearchParams({ file });
  if (debugId) q.set("debug_id", debugId);
  if (o.release) q.set("release", o.release);
  if (o.project) q.set("project", o.project);
  const doFetch = o.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(`${o.url.replace(/\/+$/, "")}/v1/sourcemaps?${q}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(mapText),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg += `: ${j.error}`;
      } catch {
        // not JSON
      }
      return { artifact: a, file, ...(debugId ? { debugId } : {}), status: res.status, error: msg };
    }
    return { artifact: a, file, ...(debugId ? { debugId } : {}), status: res.status };
  } catch (e) {
    return { artifact: a, file, ...(debugId ? { debugId } : {}), status: 0, error: String(e) };
  }
}

/** Deletes the maps so they are never deployed (and drops the bundles' sourceMappingURL lines). */
export async function deleteMaps(artifacts: Artifact[]): Promise<void> {
  for (const a of artifacts) {
    const src = await readFile(a.js, "utf8");
    const stripped = src.replace(mappingUrlComment, "").replace(/\n+$/, "\n");
    if (stripped !== src) await writeFile(a.js, stripped);
    await rm(a.map, { force: true });
  }
}
