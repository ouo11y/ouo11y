// @ouo11y/sourcemaps/hot-updater: upload the maps of every OTA bundle hot-updater builds
// (docs/sourcemaps.md "OTA updates"). Wraps the build plugin like hot-updater's own Sentry and
// Datadog plugins do; the debug id itself comes from withOuoDebugIds in metro.config.js.
import { rm } from "node:fs/promises";
import { deleteMaps, findArtifacts, upload, type UploadOptions, type UploadResult } from "./index.js";

/** What a hot-updater build plugin's build() resolves to (only buildPath is used). */
export interface BuildResultLike {
  buildPath: string;
  [k: string]: unknown;
}

/** A hot-updater build adapter (`bare({...})(args)`); typed structurally, no dependency on hot-updater. */
export interface BuildAdapterLike<B = never> {
  build: (args: B) => Promise<BuildResultLike>;
  [k: string]: unknown;
}

export interface OuoHotUpdaterOptions {
  /** rum-api base URL. Default: OUO_SOURCEMAPS_URL. */
  url?: string;
  /** The project's upload token (a CI secret). Default: OUO_UPLOAD_TOKEN. */
  token?: string;
  /** Fail unless the token is this project's. Default: OUO_PROJECT_ID. */
  project?: string;
  /**
   * The app's service.version (the store version the OTA bundle targets). Optional: debug ids
   * identify each OTA bundle. Default: OUO_RELEASE.
   */
  release?: string | ((result: BuildResultLike) => string | undefined);
  /** Delete the uploaded maps from the build output, so the OTA bundle does not ship them. Default false. */
  deleteAfter?: boolean;
  /** Throw when an upload fails, which stops the deploy (default true). */
  failOnError?: boolean;
  /** Called with each upload's result (default: one log line). */
  onUpload?: (r: UploadResult) => void;
  /** Injected for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * ```ts
 * // hot-updater.config.ts
 * import { withOuoSourcemaps } from "@ouo11y/sourcemaps/hot-updater";
 * export default defineConfig({
 *   build: withOuoSourcemaps(bare({ enableHermes: true, sourcemap: true }), { release: "1.4.0" }),
 *   ...
 * });
 * ```
 */
export function withOuoSourcemaps<A, B>(buildFn: (args: A) => BuildAdapterLike<B>, opts: OuoHotUpdaterOptions = {}): (args: A) => BuildAdapterLike<B> {
  return (args: A) => {
    const adapter = buildFn(args);
    return {
      ...adapter,
      build: async (buildArgs: B) => {
        const result = await adapter.build(buildArgs);
        await uploadBuild(result, opts);
        return result;
      },
    };
  };
}

/** Uploads every bundle + map of a hot-updater build output (Hermes bytecode and its composed map). */
export async function uploadBuild(result: BuildResultLike, opts: OuoHotUpdaterOptions = {}): Promise<UploadResult[]> {
  const env = process.env;
  const url = opts.url ?? env["OUO_SOURCEMAPS_URL"];
  const token = opts.token ?? env["OUO_UPLOAD_TOKEN"];
  const project = opts.project ?? env["OUO_PROJECT_ID"];
  const release = (typeof opts.release === "function" ? opts.release(result) : opts.release) ?? env["OUO_RELEASE"];
  const failOnError = opts.failOnError !== false;
  const log = opts.onUpload ?? ((r: UploadResult) => console.log(`[ouo] ${r.error ? `failed ${r.file}: ${r.error}` : `uploaded ${r.debugId ?? "(release only)"} ${r.file}`}`));
  const fail = (msg: string): UploadResult[] => {
    if (failOnError) throw new Error(`[ouo] ${msg}`);
    console.warn(`[ouo] ${msg}`);
    return [];
  };
  if (!url || !token) return fail("source map upload needs url and token (OUO_SOURCEMAPS_URL, OUO_UPLOAD_TOKEN)");
  const artifacts = await findArtifacts(result.buildPath);
  if (artifacts.length === 0) return fail(`no bundle with a source map in ${result.buildPath}: build with sourcemap: true`);
  const o: UploadOptions = { url, token, ...(project ? { project } : {}), ...(release ? { release } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  const results: UploadResult[] = [];
  for (const a of artifacts) {
    const r = await upload(a, o);
    log(r);
    results.push(r);
  }
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) return [...results, ...fail(`${failed.length}/${results.length} source map upload(s) failed`)];
  if (opts.deleteAfter) {
    await deleteMaps(artifacts);
    // The packager map of the JavaScript the bytecode was compiled from.
    for (const a of artifacts) if (a.js.endsWith(".hbc")) await rm(`${a.js.slice(0, -4)}.map`, { force: true });
  }
  return results;
}
