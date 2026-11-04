import { copyFile, mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { uploadBuild, withOuoSourcemaps } from "../src/hot-updater";
import {
  artifactOf,
  composeHermesMaps,
  debugIdOf,
  findArtifacts,
  inject,
  isHermesBytecode,
  markedDebugId,
  reactNativeSnippet,
  upload,
  urlPathOf,
} from "../src/index";
import { addDebugId, createOuoSerializer, ouoExpoDebugIdPlugin, withOuoDebugIds } from "../src/metro";

// The Hermes fixture rum-api's TestHermesOTABundles uses (generate.mjs there builds it).
const FIXTURE = path.resolve(__dirname, "../../../services/rum-api/internal/sourcemap/testdata/hermes");
const expected = async (): Promise<Record<string, { debug_id: string }>> => JSON.parse(await readFile(path.join(FIXTURE, "expected.json"), "utf8"));
const MAP = JSON.stringify({ version: 3, sources: ["src/App.tsx"], names: [], mappings: "AAAA;AACA" });
// What Metro writes: the prelude on line 1 (no mappings), then modules.
const METRO = 'var __BUNDLE_START_TIME__=globalThis.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=false,process=globalThis.process||{};\n__d(function(){throw new Error("x")},0,[]);\n__r(0);\n//# sourceMappingURL=index.android.bundle.map\n';

type Fetch = typeof globalThis.fetch;
function fakeFetch(): { fetch: Fetch; got: { url: URL; body: Record<string, unknown> }[] } {
  const got: { url: URL; body: Record<string, unknown> }[] = [];
  const fetch = (async (u: string, init: { body: Buffer }) => {
    got.push({ url: new URL(u), body: JSON.parse(gunzipSync(init.body).toString()) });
    return new Response("{}", { status: 201 });
  }) as unknown as Fetch;
  return { fetch, got };
}

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ouo-rn-"));
}

describe("React Native bundles", () => {
  it("finds .bundle, .jsbundle and .hbc; the bytecode wins over the JavaScript it was compiled from", async () => {
    const d = await tmp();
    await writeFile(path.join(d, "main.jsbundle"), METRO);
    await writeFile(path.join(d, "main.jsbundle.map"), MAP);
    // hot-updater / a hand-written pipeline: hermesc wrote <bundle>.hbc next to the JavaScript.
    await copyFile(path.join(FIXTURE, "v1/index.android.bundle.hbc"), path.join(d, "index.android.bundle.hbc"));
    await copyFile(path.join(FIXTURE, "v1/index.android.bundle.hbc.map"), path.join(d, "index.android.bundle.hbc.map"));
    await writeFile(path.join(d, "index.android.bundle"), METRO);
    await writeFile(path.join(d, "index.android.bundle.map"), MAP);
    const a = await findArtifacts(d);
    expect(a.map((x) => [path.basename(x.js), x.rel])).toEqual([
      ["index.android.bundle.hbc", "index.android.bundle"],
      ["main.jsbundle", "main.jsbundle"],
    ]);
    expect(urlPathOf(a[0]!)).toBe("/index.android.bundle");
    expect(artifactOf("/x/app/build/generated/assets/release/index.android.bundle", "/x/map.map").rel).toBe("index.android.bundle");
  });

  it("reads the debug id from Hermes bytecode: the snippet's literal survives hermesc", async () => {
    const exp = await expected();
    const hbc = await readFile(path.join(FIXTURE, "v1/index.android.bundle.hbc"));
    expect(isHermesBytecode(hbc)).toBe(true);
    expect(markedDebugId(hbc)).toBe(exp["v1"]!.debug_id);
    expect(markedDebugId(await readFile(path.join(FIXTURE, "v2/index.android.bundle.hbc")))).toBe(exp["v2"]!.debug_id);
    expect(markedDebugId("no id here")).toBeUndefined();
    // Two different ids: nothing is guessed.
    expect(markedDebugId(`"ouo-debug-id:${exp["v1"]!.debug_id}" "ouo-debug-id:${exp["v2"]!.debug_id}"`)).toBeUndefined();
    // Sentry's Metro plugin.
    expect(markedDebugId('e._sentryDebugIdIdentifier="sentry-dbid-0f6b3c2e-1d2a-4b5c-8d9e-0a1b2c3d4e5f"')).toBe("0f6b3c2e-1d2a-4b5c-8d9e-0a1b2c3d4e5f");
  });

  it("injects the React Native snippet into a Metro bundle, once", async () => {
    const d = await tmp();
    await writeFile(path.join(d, "index.android.bundle"), METRO);
    await writeFile(path.join(d, "index.android.bundle.map"), MAP);
    const [a] = await findArtifacts(d);
    const r = await inject(a!);
    expect(r.changed).toBe(true);
    const js = await readFile(a!.js, "utf8");
    const lines = js.trimEnd().split("\n");
    expect(lines.slice(0, 3)).toEqual(METRO.split("\n").slice(0, 3)); // no mapped line moved
    expect(lines[3]).toBe(reactNativeSnippet(r.debugId));
    expect(lines.slice(4)).toEqual([`//# debugId=${r.debugId}`, "//# sourceMappingURL=index.android.bundle.map"]);
    expect(JSON.parse(await readFile(a!.map, "utf8")).debugId).toBe(r.debugId);
    expect(markedDebugId(js)).toBe(r.debugId);
    expect(await inject(a!)).toMatchObject({ changed: false, debugId: r.debugId });
    expect(await readFile(a!.js, "utf8")).toBe(js);
  });

  it("updates only the map of a bytecode bundle, and refuses bytecode without an id", async () => {
    const exp = await expected();
    const d = await tmp();
    await copyFile(path.join(FIXTURE, "v1/index.android.bundle.hbc"), path.join(d, "index.android.bundle"));
    const map = JSON.parse(await readFile(path.join(FIXTURE, "v1/index.android.bundle.hbc.map"), "utf8"));
    delete map.debugId;
    delete map.debug_id;
    await writeFile(path.join(d, "index.android.bundle.map"), JSON.stringify(map));
    const before = await readFile(path.join(d, "index.android.bundle"));
    const [a] = await findArtifacts(d);
    expect(await inject(a!)).toMatchObject({ changed: false, debugId: exp["v1"]!.debug_id });
    expect(await readFile(a!.js)).toEqual(before);
    expect(JSON.parse(await readFile(a!.map, "utf8")).debugId).toBe(exp["v1"]!.debug_id);

    await writeFile(a!.js, Buffer.concat([before.subarray(0, 64), Buffer.alloc(64)]));
    await expect(inject(a!)).rejects.toThrow(/Hermes bytecode without a debug id/);
  });

  it("the snippet registers its bundle's file, for Hermes, JSC and V8 stack forms", () => {
    const id = "0f6b3c2e-1d2a-4b5c-8d9e-0a1b2c3d4e5f";
    const run = (stack: string): unknown => {
      // A stand-in Error whose stack is what each engine prints for the snippet's first frame.
      const ctx: Record<string, unknown> = {};
      ctx["Error"] = function () {
        return { stack };
      };
      vm.runInNewContext(reactNativeSnippet(id), ctx);
      return ctx["__ouoDebugIds"];
    };
    expect(run("Error\n    at anonymous (address at /data/user/0/com.juhi/files/bundle-store/0193/index.android.bundle:1:120)\n    at global (address at /data/user/0/com.juhi/files/bundle-store/0193/index.android.bundle:1:9)")).toEqual({
      "/data/user/0/com.juhi/files/bundle-store/0193/index.android.bundle": id,
    });
    expect(run("Error\n    at anonymous (address at index.android.bundle:1:120)")).toEqual({ "index.android.bundle": id });
    expect(run("@/var/containers/Bundle/Application/X/App.app/main.jsbundle:1:200\nglobal code@/var/x/main.jsbundle:1:2")).toEqual({
      "/var/containers/Bundle/Application/X/App.app/main.jsbundle": id,
    });
    expect(run("Error\n    at http://localhost:8081/index.bundle?platform=ios&dev=true:1:5")).toEqual({ "http://localhost:8081/index.bundle?platform=ios&dev=true": id });
    expect(run("")).toEqual({ unknown: id });
  });

  it("uploads a bytecode bundle under the id it carries, with the bundle's shipped name", async () => {
    const exp = await expected();
    const d = await tmp();
    await copyFile(path.join(FIXTURE, "v2/index.android.bundle.hbc"), path.join(d, "index.android.bundle"));
    const map = JSON.parse(await readFile(path.join(FIXTURE, "v2/index.android.bundle.hbc.map"), "utf8"));
    delete map.debugId;
    delete map.debug_id;
    await writeFile(path.join(d, "composed.map"), JSON.stringify(map));
    const a = artifactOf(path.join(d, "index.android.bundle"), path.join(d, "composed.map"));
    expect(await debugIdOf(a)).toBe(exp["v2"]!.debug_id);
    const { fetch, got } = fakeFetch();
    const r = await upload(a, { url: "http://rum-api:8080", token: "ut", release: "1.4.0", fetch });
    expect(r).toMatchObject({ status: 201, debugId: exp["v2"]!.debug_id, file: "/index.android.bundle" });
    expect(Object.fromEntries(got[0]!.url.searchParams)).toEqual({ file: "/index.android.bundle", debug_id: exp["v2"]!.debug_id, release: "1.4.0" });
  });
});

describe("Metro serializer (withOuoDebugIds)", () => {
  it("adds the snippet at the end of the prelude line: no mapped line or column moves", () => {
    const { result, debugId } = addDebugId(METRO);
    const lines = (result as string).split("\n");
    expect(lines[0]).toBe(METRO.split("\n")[0] + reactNativeSnippet(debugId!));
    expect(lines.slice(1, 3)).toEqual(METRO.split("\n").slice(1, 3));
    expect(lines.slice(3, 5)).toEqual([`//# debugId=${debugId}`, "//# sourceMappingURL=index.android.bundle.map"]);
    expect(markedDebugId(result as string)).toBe(debugId);
    // The id is derived from the bundle: the same build gets the same id.
    expect(addDebugId(METRO).debugId).toBe(debugId);
    expect(addDebugId(METRO.replace('"x"', '"y"')).debugId).not.toBe(debugId);
  });

  it("registers the id before any module runs", () => {
    const { result, debugId } = addDebugId(METRO);
    const ctx: Record<string, unknown> = { globalThis: undefined, __d() {}, __r() {} };
    ctx["globalThis"] = ctx;
    vm.runInNewContext(result as string, ctx, { filename: "index.android.bundle" });
    expect(Object.values(ctx["__ouoDebugIds"] as object)).toEqual([debugId]);
  });

  it("puts the id into a map the serializer returned, and leaves non-bundles alone", () => {
    const { result, debugId } = addDebugId({ code: METRO, map: MAP });
    expect(JSON.parse((result as { map: string }).map).debugId).toBe(debugId);
    const expoStatic = JSON.stringify([{ filename: "_expo/static/js/web/index.js", source: "x" }]);
    expect(addDebugId(expoStatic).result).toBe(expoStatic);
    // No Metro prelude: after the last line of code.
    const plain = addDebugId("a();\nb();\n");
    expect((plain.result as string).split("\n").slice(0, 3)).toEqual(["a();", "b();", reactNativeSnippet(plain.debugId!)]);
  });

  it("keeps the id a bundler already wrote, and never adds a second snippet", () => {
    const expoId = "a85fbba4-b2c5-43ea-8375-32618ac67e06";
    const withExpoId = METRO.replace("//# sourceMappingURL", `//# debugId=${expoId}\n//# sourceMappingURL`);
    const once = addDebugId({ code: withExpoId, map: JSON.stringify({ ...JSON.parse(MAP), debugId: expoId }) });
    expect(once.debugId).toBe(expoId);
    expect(markedDebugId((once.result as { code: string }).code)).toBe(expoId);
    const twice = addDebugId(once.result);
    expect(twice.result).toBe(once.result);
  });

  it("the Expo plugin adds the snippet module after Metro's prelude, with Expo's id", () => {
    const prelude = { path: "__prelude__" };
    const polyfill = { path: "/app/node_modules/@react-native/js-polyfills/console.js" };
    const out = ouoExpoDebugIdPlugin({ premodules: [prelude, polyfill], debugId: "A85FBBA4-B2C5-43EA-8375-32618AC67E06" });
    expect(out.map((m) => m.path)).toEqual(["__prelude__", "__ouo_debug_id__", polyfill.path]);
    const output = out[1]!["output"] as { type: string; data: { code: string; lineCount: number; map: unknown[] } }[];
    expect(output[0]).toEqual({ type: "js/script/virtual", data: { code: reactNativeSnippet("a85fbba4-b2c5-43ea-8375-32618ac67e06"), lineCount: 1, map: [] } });
    expect((out[1]!["getSource"] as () => Buffer)().toString()).toBe(output[0]!.data.code);
    // Idempotent, and nothing without an id (development).
    expect(ouoExpoDebugIdPlugin({ premodules: out, debugId: "a85fbba4-b2c5-43ea-8375-32618ac67e06" })).toEqual(out);
    expect(ouoExpoDebugIdPlugin({ premodules: [prelude], debugId: undefined })).toEqual([prelude]);
  });

  it("wraps an existing custom serializer (Expo's) and skips dev bundles", async () => {
    const custom = async (): Promise<{ code: string; map: string }> => ({ code: METRO, map: MAP });
    const s = createOuoSerializer(custom, process.cwd());
    const out = (await s("index.js", [], {}, { dev: false })) as { code: string; map: string };
    expect(markedDebugId(out.code)).toBe(JSON.parse(out.map).debugId);
    expect(await s("index.js", [], { transformOptions: { hot: true } }, { dev: true })).toEqual({ code: METRO, map: MAP });
    const cfg = withOuoDebugIds({ projectRoot: "/app", serializer: { customSerializer: custom, getPolyfills: () => [] } });
    expect(typeof cfg.serializer?.customSerializer).toBe("function");
    expect(cfg.serializer?.["getPolyfills"]).toBeTypeOf("function");
  });
});

describe("compose", () => {
  it("composes Metro's and hermesc's maps with the app's metro-source-map and keeps the debug id", async () => {
    const d = await tmp();
    // bundle line 1 col 0 -> src/App.tsx 1:0 ; bytecode offset 10 -> bundle 1:0
    await writeFile(path.join(d, "packager.map"), JSON.stringify({ version: 3, sources: ["src/App.tsx"], names: [], mappings: "AAAA", debugId: "0F6B3C2E-1D2A-4B5C-8D9E-0A1B2C3D4E5F" }));
    await writeFile(path.join(d, "hermes.map"), JSON.stringify({ version: 3, sources: ["index.android.bundle"], names: [], mappings: "UAAA", x_hermes_function_offsets: { 0: [0] } }));
    const r = await composeHermesMaps(path.join(d, "packager.map"), path.join(d, "hermes.map"), path.join(d, "out.map"), { cwd: path.resolve(__dirname, "../../..") });
    expect(r.debugId).toBe("0f6b3c2e-1d2a-4b5c-8d9e-0a1b2c3d4e5f");
    const out = JSON.parse(await readFile(path.join(d, "out.map"), "utf8"));
    expect(out).toMatchObject({ sources: ["src/App.tsx"], debugId: r.debugId, x_hermes_function_offsets: { 0: [0] } });
  });
});

describe("hot-updater", () => {
  async function build(): Promise<string> {
    const d = await tmp();
    for (const f of ["index.android.bundle.hbc", "index.android.bundle.hbc.map"]) await copyFile(path.join(FIXTURE, "v1", f), path.join(d, f));
    await writeFile(path.join(d, "index.android.bundle"), METRO);
    await writeFile(path.join(d, "index.android.bundle.map"), MAP);
    return d;
  }

  it("uploads the composed map of every OTA bundle after the build plugin ran", async () => {
    const exp = await expected();
    const d = await build();
    const { fetch, got } = fakeFetch();
    const calls: string[] = [];
    const bare = (_: { cwd: string }) => ({ name: "bare", build: async (b: { platform: string }) => (calls.push(b.platform), { buildPath: d, bundleId: "0193" }) });
    const adapter = withOuoSourcemaps(bare, { url: "http://rum-api:8080", token: "ut", release: "1.4.0", fetch, onUpload: () => {}, deleteAfter: true })({ cwd: "/app" });
    expect(adapter["name"]).toBe("bare");
    expect(await adapter.build({ platform: "android" })).toEqual({ buildPath: d, bundleId: "0193" });
    expect(calls).toEqual(["android"]);
    expect(got).toHaveLength(1);
    expect(Object.fromEntries(got[0]!.url.searchParams)).toEqual({ file: "/index.android.bundle", debug_id: exp["v1"]!.debug_id, release: "1.4.0" });
    expect(got[0]!.body["x_hermes_function_offsets"]).toBeDefined();
    // deleteAfter: neither map ships in the OTA bundle.
    await expect(access(path.join(d, "index.android.bundle.hbc.map"))).rejects.toThrow();
    await expect(access(path.join(d, "index.android.bundle.map"))).rejects.toThrow();
    await access(path.join(d, "index.android.bundle.hbc"));
  });

  it("fails the deploy without url or token, or when an upload fails (unless failOnError is false)", async () => {
    const d = await build();
    const env = { ...process.env };
    delete process.env["OUO_SOURCEMAPS_URL"];
    delete process.env["OUO_UPLOAD_TOKEN"];
    try {
      await expect(uploadBuild({ buildPath: d })).rejects.toThrow(/needs url and token/);
      const failing = (async () => new Response('{"error":"upload token required"}', { status: 401 })) as unknown as Fetch;
      await expect(uploadBuild({ buildPath: d }, { url: "http://x", token: "t", fetch: failing, onUpload: () => {} })).rejects.toThrow(/1\/1 source map upload/);
      const r = await uploadBuild({ buildPath: d }, { url: "http://x", token: "t", fetch: failing, onUpload: () => {}, failOnError: false });
      expect(r[0]?.error).toBe("HTTP 401: upload token required");
      await mkdir(path.join(d, "empty"));
      await expect(uploadBuild({ buildPath: path.join(d, "empty") }, { url: "http://x", token: "t" })).rejects.toThrow(/sourcemap: true/);
    } finally {
      process.env = env;
    }
  });
});
