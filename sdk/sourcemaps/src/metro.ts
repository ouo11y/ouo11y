// @ouo11y/sourcemaps/metro: a debug id in every React Native release bundle, at bundle time
// (ADR-0011 section 6, docs/sourcemaps.md "React Native").
//
// A Hermes release build compiles the bundle to bytecode right after Metro (Gradle, Xcode,
// hot-updater, expo-updates), so nothing can be appended later. The serializer below adds the
// registration snippet while Metro writes the bundle: every way of building one (react-native
// bundle, the Gradle plugin, react-native-xcode.sh, hot-updater's bare plugin) reads
// metro.config.js, so one line there covers them all.
import { createRequire } from "node:module";
import path from "node:path";
import { debugIdFor, markedDebugId, reactNativeSnippet, splitTrailing } from "./index.js";

/** What a Metro serializer returns: the code, or the code and its map (JSON text). */
export type SerializerResult = string | { code: string; map: string };

// Metro's types are internal and change between versions: the serializer only passes them on.
export type MetroSerializer = (
  entryPoint: string,
  preModules: readonly unknown[],
  graph: { transformOptions?: { hot?: boolean } } & Record<string, unknown>,
  options: Record<string, unknown>,
) => SerializerResult | Promise<SerializerResult>;

export interface MetroConfigLike {
  projectRoot?: string;
  serializer?: { customSerializer?: MetroSerializer | null } & Record<string, unknown>;
  [k: string]: unknown;
}

// Metro's prelude (`var __BUNDLE_START_TIME__=...,__DEV__=false,process=...;`) is line 1 of every
// bundle and has no mappings, so code added at its end moves no mapped position and runs before
// any module: the id is registered even for an error thrown while the bundle loads.
const PRELUDE = /^var __BUNDLE_START_TIME__/;

/**
 * Adds a debug id to a serialized bundle: the React Native snippet at the end of the prelude
 * line (else after the last line of code), `//# debugId=` before a trailing
 * `//# sourceMappingURL=`, and `debugId` in the map when the serializer returned one. The id is
 * derived from the bundle as Metro wrote it, so the same build gets the same id. A result that
 * is not one bundle (Expo's static export returns a JSON list of files) is returned unchanged.
 */
export function addDebugId(result: SerializerResult): { result: SerializerResult; debugId?: string } {
  const code = typeof result === "string" ? result : result?.code;
  if (typeof code !== "string") return { result };
  const head = code.trimStart();
  if (head.startsWith("[") || head.startsWith("{")) return { result };
  // Already registered (ouoExpoDebugIdPlugin ran, or the bundle went through this twice).
  const marked = markedDebugId(code);
  if (marked) return { result, debugId: marked };
  const t = splitTrailing(code);
  // A bundler that writes debug ids itself (Expo's serializer) has put the same id in its map: keep it.
  const id = t.debugId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t.debugId) ? t.debugId : debugIdFor(code);
  const snippet = reactNativeSnippet(id);
  let body = t.body;
  const nl = body.indexOf("\n");
  const first = nl < 0 ? body : body.slice(0, nl);
  if (PRELUDE.test(first) && !first.includes("//")) {
    body = first + snippet + (nl < 0 ? "" : body.slice(nl));
  } else {
    body = `${body}\n${snippet}`;
  }
  const out = [body, `//# debugId=${id}`, ...(t.mappingComment ? [t.mappingComment] : [])].join("\n") + "\n";
  if (typeof result === "string") return { result: out, debugId: id };
  let map = result.map;
  try {
    const m = JSON.parse(map) as Record<string, unknown>;
    m["debugId"] = id;
    m["debug_id"] = id;
    map = JSON.stringify(m);
  } catch {
    // not JSON: keep it as it is
  }
  return { result: { code: out, map }, debugId: id };
}

/** Metro's own serializer (baseJSBundle + bundleToString), resolved from the app's Metro. */
function defaultSerializer(projectRoot: string): MetroSerializer {
  const req = createRequire(path.join(projectRoot, "package.json"));
  const load = (name: string): unknown => {
    let last: unknown;
    // Metro 0.83+ exposes its internals under metro/private, older ones under metro/src.
    for (const base of ["metro/private", "metro/src"]) {
      try {
        const m = req(`${base}/${name}`) as { default?: unknown };
        return m.default ?? m;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
  const baseJSBundle = load("DeltaBundler/Serializers/baseJSBundle") as (...a: unknown[]) => unknown;
  const bundleToString = load("lib/bundleToString") as (b: unknown) => { code: string };
  return (entryPoint, preModules, graph, options) => bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code;
}

export interface OuoMetroOptions {
  /** Also add ids to development bundles served by Metro (default false: they are never uploaded). */
  dev?: boolean;
}

/**
 * A Metro `serializer.customSerializer` that adds a debug id to every bundle: `custom` (the
 * config's existing custom serializer) or Metro's default one writes the bundle, then
 * `addDebugId`. When it returns only code, Metro computes the map itself, which stays exact:
 * nothing mapped moved.
 */
export function createOuoSerializer(custom: MetroSerializer | null | undefined, projectRoot: string, opts: OuoMetroOptions = {}): MetroSerializer {
  let fallback: MetroSerializer | undefined;
  return async (entryPoint, preModules, graph, options) => {
    const serialize = custom ?? (fallback ??= defaultSerializer(projectRoot));
    const result = await serialize(entryPoint, preModules, graph, options);
    if (!opts.dev && (options["dev"] === true || graph.transformOptions?.hot === true)) return result;
    return addDebugId(result).result;
  };
}

/**
 * Wraps a Metro config so that every release bundle carries a debug id (bare React Native):
 *
 * ```js
 * // metro.config.js
 * const { withOuoDebugIds } = require("@ouo11y/sourcemaps/metro");
 * module.exports = withOuoDebugIds(mergeConfig(getDefaultConfig(__dirname), {}));
 * ```
 *
 * Expo exports bundles through its own serializer, which this wrapper cannot reach: use
 * `ouoExpoDebugIdPlugin` there.
 */
export function withOuoDebugIds<T extends MetroConfigLike>(config: T, opts: OuoMetroOptions = {}): T {
  const projectRoot = config.projectRoot ?? process.cwd();
  return {
    ...config,
    serializer: { ...config.serializer, customSerializer: createOuoSerializer(config.serializer?.customSerializer, projectRoot, opts) },
  };
}

/** The module shape Metro serializes; only what a virtual script module needs. */
export interface MetroModuleLike {
  path: string;
  [k: string]: unknown;
}

const DEBUG_ID_MODULE = "__ouo_debug_id__";

/** A one-line virtual script module holding the registration snippet (no mappings, like Metro's prelude). */
export function debugIdModule(debugId: string): MetroModuleLike {
  const code = reactNativeSnippet(debugId);
  return {
    path: DEBUG_ID_MODULE,
    dependencies: new Map(),
    inverseDependencies: new Set(),
    getSource: () => Buffer.from(code),
    output: [{ type: "js/script/virtual", data: { code, lineCount: 1, map: [] } }],
  };
}

/**
 * Expo (SDK 50+): Expo's serializer computes a debug id for every exported bundle and writes it
 * as `//# debugId=` and into the map, but Hermes drops that comment. This plugin adds the
 * registration snippet with Expo's own id, right after Metro's prelude, so the id reaches the
 * runtime and the bytecode:
 *
 * ```js
 * // metro.config.js
 * const { getDefaultConfig } = require("expo/metro-config");
 * const { ouoExpoDebugIdPlugin } = require("@ouo11y/sourcemaps/metro");
 * module.exports = getDefaultConfig(__dirname, { unstable_beforeAssetSerializationPlugins: [ouoExpoDebugIdPlugin] });
 * ```
 *
 * Expo builds the source map from the same module list, so every mapping accounts for the added
 * line. Without a debug id (development bundles) it changes nothing.
 */
export function ouoExpoDebugIdPlugin({ premodules, debugId }: { premodules: readonly MetroModuleLike[]; debugId?: string | undefined; graph?: unknown }): MetroModuleLike[] {
  if (!debugId || premodules.some((m) => m.path === DEBUG_ID_MODULE)) return [...premodules];
  const mod = debugIdModule(debugId.toLowerCase());
  const prelude = premodules.findIndex((m) => m.path === "__prelude__");
  return prelude >= 0 ? [...premodules.slice(0, prelude + 1), mod, ...premodules.slice(prelude + 1)] : [mod, ...premodules];
}
