import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { build } from "tsup";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { debugIdFor, deleteMaps, findArtifacts, findDSYMs, inject, machoSlices, splitTrailing, upload, uploadDSYM, urlPathOf } from "../src/index";

const FIXTURES = path.resolve(__dirname, "fixtures");
const MAP = JSON.stringify({ version: 3, sources: ["../src/a.ts"], names: [], mappings: "AAAA" });

/** A minimal thin Mach-O: header, one 8-byte load command, then LC_UUID (the last 24 bytes). */
function thinMachO(o: { is64: boolean; le: boolean; cpu: number; uuid: string }): Buffer {
  const hdr = o.is64 ? 32 : 28;
  const b = Buffer.alloc(hdr + 8 + 24);
  const w = (v: number, at: number) => (o.le ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at));
  w(o.is64 ? 0xfeedfacf : 0xfeedface, 0);
  w(o.cpu, 4);
  w(0xa, 12); // MH_DSYM
  w(2, 16); // ncmds
  w(32, 20); // sizeofcmds
  w(0x26, hdr); // LC_FUNCTION_STARTS, any command
  w(8, hdr + 4);
  w(0x1b, hdr + 8); // LC_UUID
  w(24, hdr + 12);
  Buffer.from(o.uuid, "hex").copy(b, hdr + 16);
  return b;
}

/** A universal file with 64-bit fat_arch entries (0xcafebabf), slices aligned to 16 bytes. */
function fat64(slices: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(8 + 32 * slices.length);
  head.writeUInt32BE(0xcafebabf, 0);
  head.writeUInt32BE(slices.length, 4);
  let at = Math.ceil(head.length / 16) * 16;
  parts.push(head, Buffer.alloc(at - head.length));
  slices.forEach((s, i) => {
    const e = 8 + 32 * i;
    head.writeBigUInt64BE(BigInt(at), e + 8);
    head.writeBigUInt64BE(BigInt(s.length), e + 16);
    head.writeUInt32BE(4, e + 24);
    const pad = Math.ceil(s.length / 16) * 16 - s.length;
    parts.push(s, Buffer.alloc(pad));
    at += s.length + pad;
  });
  return Buffer.concat(parts);
}

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

    type Got = { method: string; url: string; auth: string; encoding: string; body: unknown; raw: Buffer };

    /** A fake Muninn upload route: answers each PUT with status(n) (n counts from 0). */
    async function server(status: number | ((n: number) => number) = 201) {
      const got: Got[] = [];
      const statusOf = typeof status === "number" ? () => status : status;
      const srv = createServer((req: IncomingMessage, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const raw = gunzipSync(Buffer.concat(chunks));
          let body: unknown;
          try {
            body = JSON.parse(raw.toString());
          } catch {
            // a dSYM
          }
          const s = statusOf(got.length);
          got.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? "", encoding: String(req.headers["content-encoding"]), body, raw });
          res.writeHead(s, { "content-type": "application/json" });
          res.end(JSON.stringify(s === 201 || s === 200 ? { kind: "sourcemap" } : { error: s === 401 ? "unauthorized" : "conflict" }));
        });
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      close = () => srv.close();
      const port = (srv.address() as { port: number }).port;
      return { url: `http://127.0.0.1:${port}/`, got };
    }

    it("PUTs a gzip map to the project's debug-files route with the token, release and file", async () => {
      const d = await dist();
      const arts = await findArtifacts(d);
      const { debugId } = await inject(arts[0]!);
      const { url, got } = await server();
      const r = await upload(arts[0]!, { url, token: "ut_secret", project: "web-store", release: "1.4.2" });
      expect(r).toMatchObject({ status: 201, debugId, file: "/assets/index-B3x9.js" });
      expect(r.error).toBeUndefined();
      const u = new URL(got[0]!.url, "http://x");
      expect(got[0]!.method).toBe("PUT");
      expect(u.pathname).toBe(`/api/v1/projects/web-store/debug-files/sourcemap/${debugId}`);
      expect(Object.fromEntries(u.searchParams)).toEqual({ release: "1.4.2", file: "/assets/index-B3x9.js" });
      expect(got[0]!.auth).toBe("Bearer ut_secret");
      expect(got[0]!.encoding).toBe("gzip");
      expect((got[0]!.body as { debugId: string }).debugId).toBe(debugId);
    });

    it("sends neither release nor file without a release, and puts --url-prefix in the file", async () => {
      const d = await dist();
      const arts = await findArtifacts(d);
      const { debugId } = await inject(arts[0]!);
      const { url, got } = await server();
      await upload(arts[0]!, { url, token: "t", project: "web-store" });
      expect(got[0]!.url).toBe(`/api/v1/projects/web-store/debug-files/sourcemap/${debugId}`);
      await upload(arts[0]!, { url, token: "t", project: "web-store", release: "1", urlPrefix: "/static/" });
      expect(new URL(got[1]!.url, "http://x").searchParams.get("file")).toBe("/static/assets/index-B3x9.js");
    });

    it("succeeds on 201 and 200, fails on 409 (other content under the id), 401 and other errors", async () => {
      const d = await dist();
      const arts = await findArtifacts(d);
      const { debugId } = await inject(arts[0]!);
      const statuses = [201, 200, 409, 401, 503];
      const { url } = await server((n) => statuses[n]!);
      const o = { url, token: "t", project: "web-store" };
      expect(await upload(arts[0]!, o)).toMatchObject({ status: 201 });
      expect((await upload(arts[0]!, o)).error).toBeUndefined();
      expect(await upload(arts[0]!, o)).toMatchObject({
        status: 409,
        error: `HTTP 409: sourcemap ${debugId} is already stored with different content (debug files are write-once)`,
      });
      expect(await upload(arts[0]!, o)).toMatchObject({ status: 401, error: "HTTP 401: unauthorized" });
      expect(await upload(arts[0]!, o)).toMatchObject({ status: 503, error: "HTTP 503: conflict" });
    });

    it("derives the debug id of a map without one from its bytes when a release is given", async () => {
      const d = await dist();
      const arts = await findArtifacts(d);
      const { url, got } = await server();
      expect((await upload(arts[1]!, { url, token: "t", project: "web-store" })).error).toMatch(/no debug id/);
      expect(got).toHaveLength(0);
      const r = await upload(arts[1]!, { url, token: "t", project: "web-store", release: "1.4.2" });
      const id = debugIdFor(await readFile(arts[1]!.map));
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(r).toMatchObject({ status: 201, debugId: id, derived: true });
      const u = new URL(got[0]!.url, "http://x");
      expect(u.pathname).toBe(`/api/v1/projects/web-store/debug-files/sourcemap/${id}`);
      expect(Object.fromEntries(u.searchParams)).toEqual({ release: "1.4.2", file: "/assets/vendor.js" });
    });

    it("needs a project", async () => {
      const d = await dist();
      const arts = await findArtifacts(d);
      await inject(arts[0]!);
      const { url, got } = await server();
      const r = await upload(arts[0]!, { url, token: "t", project: "" });
      expect(r.error).toMatch(/no project/);
      expect(got).toHaveLength(0);
    });

    it("splits the real universal dSYM fixture into its slices by LC_UUID", async () => {
      const b = await readFile(path.join(FIXTURES, "dsym", "crashy.dwarf"));
      const slices = machoSlices(b);
      expect(slices.map((s) => [s.uuid, s.arch])).toEqual([
        ["af6a9aa7-dee9-35d6-90c3-f007eceb1efc", "x86_64"],
        ["3ccbba5f-01c6-36b3-9475-412655ac7ffe", "arm64"],
      ]);
      for (const s of slices) expect(s.data.readUInt32LE(0)).toBe(0xfeedfacf);
      expect(slices[0]!.data.length + slices[1]!.data.length).toBeLessThan(b.length);
    });

    it("reads thin Mach-O in both byte orders, 32 and 64-bit, and fat64", () => {
      const a = thinMachO({ is64: true, le: true, cpu: 0x0100000c, uuid: "00112233445566778899aabbccddeeff" });
      const b = thinMachO({ is64: false, le: false, cpu: 7, uuid: "ffeeddccbbaa99887766554433221100" });
      expect(machoSlices(a).map((s) => [s.uuid, s.arch])).toEqual([["00112233-4455-6677-8899-aabbccddeeff", "arm64"]]);
      expect(machoSlices(a)[0]!.data).toEqual(a);
      expect(machoSlices(b).map((s) => [s.uuid, s.arch])).toEqual([["ffeeddcc-bbaa-9988-7766-554433221100", "i386"]]);
      const fat = fat64([a, b]);
      const slices = machoSlices(fat);
      expect(slices.map((s) => s.uuid)).toEqual(["00112233-4455-6677-8899-aabbccddeeff", "ffeeddcc-bbaa-9988-7766-554433221100"]);
      expect(slices[1]!.data).toEqual(b);
      expect(() => machoSlices(Buffer.from("not mach-o at all, no"))).toThrow(/not a Mach-O file/);
      const noUUID = thinMachO({ is64: true, le: true, cpu: 0x01000007, uuid: "00112233445566778899aabbccddeeff" });
      noUUID.writeUInt32LE(0x26, (noUUID.length - 24)); // the LC_UUID becomes another command
      expect(() => machoSlices(noUUID)).toThrow(/no LC_UUID in the x86_64 slice/);
    });

    it("finds the DWARF files of .dSYM bundles and PUTs each slice under its LC_UUID", async () => {
      const d = await mkdtemp(path.join(tmpdir(), "ouo-dsym-"));
      const dwarf = path.join(d, "Products", "App.app.dSYM", "Contents", "Resources", "DWARF");
      await mkdir(dwarf, { recursive: true });
      await copyFile(path.join(FIXTURES, "dsym", "crashy.dwarf"), path.join(dwarf, "App"));
      await writeFile(path.join(d, "Products", "App.app.dSYM", "Contents", "Info.plist"), "<plist/>");
      await writeFile(path.join(d, "Products", "other.txt"), "x");
      const files = await findDSYMs(d);
      expect(files).toEqual([path.join(dwarf, "App")]);
      expect(await findDSYMs(path.join(d, "Products", "App.app.dSYM"))).toEqual(files);
      expect(await findDSYMs(files[0]!)).toEqual(files);

      const { url, got } = await server((n) => (n === 0 ? 201 : 200));
      const r = await uploadDSYM(files[0]!, { url, token: "ut_secret", project: "ios-app", release: "2.0.0" });
      const slices = [
        { debug_id: "af6a9aa7-dee9-35d6-90c3-f007eceb1efc", arch: "x86_64" },
        { debug_id: "3ccbba5f-01c6-36b3-9475-412655ac7ffe", arch: "arm64" },
      ];
      expect(r).toEqual({ file: files[0], status: 200, dsyms: slices });
      expect(got.map((g) => g.url)).toEqual(slices.map((s) => `/api/v1/projects/ios-app/debug-files/dsym/${s.debug_id}?release=2.0.0`));
      expect(got[0]!.auth).toBe("Bearer ut_secret");
      expect(got[0]!.encoding).toBe("gzip");
      const parsed = machoSlices(await readFile(files[0]!));
      expect(got.map((g) => g.raw)).toEqual(parsed.map((s) => s.data));
    });

    it("reports dSYM errors: not Mach-O, and a slice the server refuses", async () => {
      const d = await mkdtemp(path.join(tmpdir(), "ouo-dsym-"));
      await writeFile(path.join(d, "App"), "not mach-o");
      const { url, got } = await server((n) => (n === 0 ? 201 : 409));
      expect(await uploadDSYM(path.join(d, "App"), { url, token: "t", project: "p" })).toMatchObject({ status: 0, error: "not a Mach-O file" });
      expect(got).toHaveLength(0);
      const r = await uploadDSYM(path.join(FIXTURES, "dsym", "crashy.dwarf"), { url, token: "t", project: "p" });
      expect(r.dsyms).toEqual([{ debug_id: "af6a9aa7-dee9-35d6-90c3-f007eceb1efc", arch: "x86_64" }]);
      expect(r.error).toMatch(/^arm64: HTTP 409: dsym 3ccbba5f-01c6-36b3-9475-412655ac7ffe is already stored with different content/);
      expect(got[0]!.url).toBe("/api/v1/projects/p/debug-files/dsym/af6a9aa7-dee9-35d6-90c3-f007eceb1efc");
    });

    describe("the CLI", () => {
      let cli = "";
      beforeAll(async () => {
        const out = await mkdtemp(path.join(tmpdir(), "ouo-cli-"));
        await build({ entry: { cli: path.resolve(__dirname, "../src/cli.ts") }, format: ["esm"], platform: "node", target: "node24", outDir: out, config: false, silent: true });
        cli = path.join(out, "cli.js");
      }, 60_000);

      const run = (args: string[], env: Record<string, string> = {}) => {
        const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OUO_")));
        return new Promise<{ code: number; out: string; err: string }>((resolve) => {
          execFile(process.execPath, [cli, ...args], { env: { ...clean, ...env } }, (e, out, err) =>
            resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }),
          );
        });
      };

      it("requires --project (or OUO_PROJECT_ID)", async () => {
        const d = await dist();
        const r = await run(["upload", d, "--url", "http://127.0.0.1:1", "--token", "t"]);
        expect(r.code).toBe(2);
        expect(r.err).toContain("--project (or OUO_PROJECT_ID) is required");
        const dsym = await run(["upload-dsym", path.join(FIXTURES, "dsym", "crashy.dwarf"), "--url", "http://127.0.0.1:1", "--token", "t"]);
        expect(dsym.code).toBe(2);
      });

      it("exits 1 and keeps the maps when one upload answers 409", async () => {
        const d = await dist();
        const { url } = await server((n) => (n === 0 ? 201 : 409));
        const r = await run(["inject-and-upload", d, "--url", url, "--token", "t", "--delete-after"], { OUO_PROJECT_ID: "web-store" });
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/failed {3}\/assets\/vendor\.js: HTTP 409: sourcemap [0-9a-f-]{36} is already stored with different content/);
        expect(r.out).toContain("1/2 map(s) uploaded");
        await access(path.join(d, "assets", "maps", "vendor.map")); // --delete-after only after every upload succeeded
      });

      it("prints one line per dSYM slice", async () => {
        const { url } = await server();
        const r = await run(["upload-dsym", path.join(FIXTURES, "dsym", "crashy.dwarf"), "--url", url, "--token", "t", "--project", "ios-app"]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("uploaded af6a9aa7-dee9-35d6-90c3-f007eceb1efc (x86_64)");
        expect(r.out).toContain("uploaded 3ccbba5f-01c6-36b3-9475-412655ac7ffe (arm64)");
      });
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
