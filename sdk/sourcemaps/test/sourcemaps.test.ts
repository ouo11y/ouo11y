import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { debugIdFor, deleteMaps, findArtifacts, inject, splitTrailing, upload, urlPathOf } from "../src/index";

const MAP = JSON.stringify({ version: 3, sources: ["../src/a.ts"], names: [], mappings: "AAAA" });

async function dist(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "ouo-sm-"));
  await mkdir(path.join(d, "assets"));
  // Vite "hidden": no sourceMappingURL, sibling .map.
  await writeFile(path.join(d, "assets", "index-B3x9.js"), 'console.log("a")');
  await writeFile(path.join(d, "assets", "index-B3x9.js.map"), MAP);
  // webpack / esbuild default: a sourceMappingURL comment naming another file name.
  await writeFile(path.join(d, "assets", "vendor.js"), 'var x=1\n//# sourceMappingURL=maps/vendor.map\n');
  await mkdir(path.join(d, "assets", "maps"));
  await writeFile(path.join(d, "assets", "maps", "vendor.map"), MAP.replace("a.ts", "v.ts"));
  // No map: ignored. Inline map: ignored.
  await writeFile(path.join(d, "assets", "nomap.js"), "1");
  await writeFile(path.join(d, "inline.js"), "1\n//# sourceMappingURL=data:application/json;base64,e30=\n");
  return d;
}

describe("ouo-sourcemaps", () => {
  it("finds bundles and their maps", async () => {
    const d = await dist();
    const a = await findArtifacts(d);
    expect(a.map((x) => [x.rel, path.relative(d, x.map)])).toEqual([
      ["assets/index-B3x9.js", path.join("assets", "index-B3x9.js.map")],
      ["assets/vendor.js", path.join("assets", "maps", "vendor.map")],
    ]);
    expect(urlPathOf(a[0]!)).toBe("/assets/index-B3x9.js");
    expect(urlPathOf(a[0]!, "static")).toBe("/static/assets/index-B3x9.js");
  });

  it("derives a stable UUID from the map", () => {
    const id = debugIdFor(MAP);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(debugIdFor(MAP)).toBe(id);
    expect(debugIdFor(MAP + " ")).not.toBe(id);
  });

  it("injects once, keeps the mapped lines and the sourceMappingURL last", async () => {
    const d = await dist();
    const [index, vendor] = await findArtifacts(d);
    const r1 = await inject(vendor!);
    expect(r1.changed).toBe(true);
    const js = await readFile(vendor!.js, "utf8");
    const lines = js.trimEnd().split("\n");
    expect(lines[0]).toBe("var x=1"); // the code's lines are untouched
    expect(lines[2]).toBe(`//# debugId=${r1.debugId}`);
    expect(lines[3]).toBe("//# sourceMappingURL=maps/vendor.map");
    expect(JSON.parse(await readFile(vendor!.map, "utf8")).debugId).toBe(r1.debugId);

    const r2 = await inject(vendor!);
    expect(r2).toMatchObject({ changed: false, debugId: r1.debugId });
    expect(await readFile(vendor!.js, "utf8")).toBe(js);

    const r3 = await inject(index!);
    expect(r3.debugId).not.toBe(r1.debugId);
  });

  it("adds the snippet to a bundle whose bundler already wrote the debug id", async () => {
    const d = await dist();
    const [index] = await findArtifacts(d);
    const id = "0a1b2c3d-0000-4000-8000-000000000000";
    await writeFile(index!.js, `console.log(1)\n//# debugId=${id}\n`);
    const r = await inject(index!);
    expect(r).toMatchObject({ changed: true, debugId: id });
    const js = await readFile(index!.js, "utf8");
    expect(js.match(/debugId=/g)).toHaveLength(1);
    expect(js).toContain("__ouoDebugIds");
  });

  it("adds the snippet to a bundle that contains the SDK (which names __ouoDebugIds too)", async () => {
    const d = await dist();
    const [index] = await findArtifacts(d);
    await writeFile(index!.js, 'const reg = globalThis.__ouoDebugIds;console.log(reg)');
    const r = await inject(index!);
    const js = await readFile(index!.js, "utf8");
    expect(js.split("\n")[1]).toContain(`[u[0]]="${r.debugId}"`);
    expect((await inject(index!)).changed).toBe(false);
  });

  it("handles terser output: sourceMappingURL on the same line as the code", async () => {
    const d = await dist();
    const [, vendor] = await findArtifacts(d);
    await writeFile(vendor!.js, "export{a as b};//# sourceMappingURL=maps/vendor.map");
    expect((await findArtifacts(d)).map((a) => path.relative(d, a.map))).toContain(path.join("assets", "maps", "vendor.map"));
    const r = await inject(vendor!);
    const lines = (await readFile(vendor!.js, "utf8")).trimEnd().split("\n");
    expect(lines).toEqual(["export{a as b};", expect.stringContaining("__ouoDebugIds"), `//# debugId=${r.debugId}`, "//# sourceMappingURL=maps/vendor.map"]);
    expect((await inject(vendor!)).changed).toBe(false);
    await deleteMaps([vendor!]);
    expect(await readFile(vendor!.js, "utf8")).toBe(`${lines[0]}\n${lines[1]}\n//# debugId=${r.debugId}\n`);
  });

  it("splits trailing comments in either order and leaves code alone", () => {
    expect(splitTrailing('a()\n//# sourceMappingURL=a.map\n//# debugId=ABC\n')).toEqual({
      body: "a()", debugId: "abc", mappingUrl: "a.map", mappingComment: "//# sourceMappingURL=a.map",
    });
    expect(splitTrailing('s="//# debugId=x";f()')).toEqual({ body: 's="//# debugId=x";f()' });
  });

  it("the snippet registers the bundle's own URL under its debug id", async () => {
    const d = await dist();
    const [index, vendor] = await findArtifacts(d);
    const a = await inject(index!);
    const b = await inject(vendor!);
    const ctx: Record<string, unknown> = { console: { log() {} } };
    vm.runInNewContext(await readFile(index!.js, "utf8"), ctx, { filename: "https://shop.example/assets/index-B3x9.js" });
    vm.runInNewContext(await readFile(vendor!.js, "utf8"), ctx, { filename: "http://localhost:4173/assets/vendor.js" });
    expect((ctx as { __ouoDebugIds?: Record<string, string> }).__ouoDebugIds).toEqual({
      "https://shop.example/assets/index-B3x9.js": a.debugId,
      "http://localhost:4173/assets/vendor.js": b.debugId,
    });
  });

  describe("upload", () => {
    let close: (() => void) | undefined;
    afterEach(() => close?.());

    async function server(status = 201) {
      const got: { url: string; auth: string; body: unknown }[] = [];
      const srv = createServer((req: IncomingMessage, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          got.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", body: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()) });
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(status === 201 ? {} : { error: "upload token required" }));
        });
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      close = () => srv.close();
      const port = (srv.address() as { port: number }).port;
      return { url: `http://127.0.0.1:${port}/`, got };
    }

    it("PUTs gzip maps with the token, debug id, file and release", async () => {
      const d = await dist();
      const arts = await findArtifacts(d);
      const { debugId } = await inject(arts[0]!);
      const { url, got } = await server();
      const r = await upload(arts[0]!, { url, token: "ut_secret", release: "1.4.2", project: "web-store" });
      expect(r).toMatchObject({ status: 201, debugId, file: "/assets/index-B3x9.js" });
      const q = new URL(got[0]!.url, "http://x").searchParams;
      expect(got[0]!.url.startsWith("/v1/sourcemaps?")).toBe(true);
      expect(Object.fromEntries(q)).toEqual({ file: "/assets/index-B3x9.js", debug_id: debugId, release: "1.4.2", project: "web-store" });
      expect(got[0]!.auth).toBe("Bearer ut_secret");
      expect((got[0]!.body as { debugId: string }).debugId).toBe(debugId);
    });

    it("needs a debug id or a release, and reports server errors", async () => {
      const d = await dist();
      const arts = await findArtifacts(d);
      const { url } = await server(401);
      expect((await upload(arts[1]!, { url, token: "t" })).error).toMatch(/no debug id/);
      const r = await upload(arts[1]!, { url, token: "t", release: "1" });
      expect(r).toMatchObject({ status: 401, error: "HTTP 401: upload token required" });
    });

    it("deletes maps and their sourceMappingURL lines", async () => {
      const d = await dist();
      const arts = await findArtifacts(d);
      await deleteMaps(arts);
      await expect(access(arts[1]!.map)).rejects.toThrow();
      expect(await readFile(arts[1]!.js, "utf8")).toBe("var x=1\n");
    });
  });
});
