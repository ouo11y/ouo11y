// Bundles each variant the way an app bundler would (esbuild, minified, ESM, code splitting) and
// reports raw, gzip (level 9) and brotli (quality 11) sizes of the initial entry and of all chunks.
import { build } from "esbuild";
import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
const variants = readdirSync("entries").map((f) => f.replace(/\.js$/, ""));
const out = {};
for (const v of variants) {
  rmSync(`dist/${v}`, { recursive: true, force: true });
  const r = await build({ entryPoints: { app: `entries/${v}.js` }, bundle: true, minify: true, format: "esm", splitting: true, outdir: `dist/${v}`, metafile: true, target: "es2022", platform: "browser", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });
  const files = Object.keys(r.metafile.outputs).filter((f) => f.endsWith(".js"));
  const sz = (f) => { const b = readFileSync(f); return { raw: b.length, gzip: gzipSync(b, { level: 9 }).length, brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length }; };
  const sum = (a) => a.reduce((s, x) => ({ raw: s.raw + x.raw, gzip: s.gzip + x.gzip, brotli: s.brotli + x.brotli }), { raw: 0, gzip: 0, brotli: 0 });
  const entry = sz(`dist/${v}/app.js`);
  const all = sum(files.map(sz));
  out[v] = { initial: entry, total: all, files: files.length };
  console.log(v.padEnd(16), "initial gz", (entry.gzip / 1024).toFixed(1), "br", (entry.brotli / 1024).toFixed(1), "| total gz", (all.gzip / 1024).toFixed(1), "br", (all.brotli / 1024).toFixed(1), "KiB", files.length, "files");
}
mkdirSync("results", { recursive: true }); writeFileSync("results/bundle.json", JSON.stringify(out, null, 1));
