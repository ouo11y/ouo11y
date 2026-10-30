// Bundles every cell's entry with esbuild (--bundle --minify --format=esm --target=es2022, code
// splitting so lazy chunks stay lazy) into dist/<cell>/sdk.js, and writes dist/sizes.json with the
// raw and gzip -9 size of every output file, split into eager (sdk.js and what it imports
// statically) and lazy (dynamic imports). esbuild moves code shared by the entry and a lazy chunk
// into a shared chunk the entry imports statically, so "entry" alone understates the eager cost.
// Usage: node build.mjs --ouo <dir of the built @ouo11y/browser package>
import { build } from "esbuild";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { gzipSync, constants } from "node:zlib";
import { join, resolve } from "node:path";
import { CELLS } from "./cells.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const ouoDir = resolve(arg("--ouo") ?? "../ouo-build");
const ouoEntry = join(ouoDir, "dist/index.js");
await readFile(ouoEntry); // fail early when the ouo build is missing

await rm("dist", { recursive: true, force: true });
const sizes = {};
for (const [cell, { entry, replay }] of Object.entries(CELLS)) {
  const outdir = join("dist", cell);
  const { metafile } = await build({
    metafile: true,
    entryPoints: { sdk: join("entries", `${entry}.js`) },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    splitting: true,
    outdir,
    platform: "browser",
    define: { __REPLAY__: String(replay) },
    alias: { "@ouo11y/browser": ouoEntry },
    logLevel: "warning",
    legalComments: "none",
  });
  const files = {};
  for (const f of (await readdir(outdir)).filter((f) => f.endsWith(".js"))) {
    const buf = await readFile(join(outdir, f));
    files[f] = { bytes: buf.length, gz9: gzipSync(buf, { level: constants.Z_BEST_COMPRESSION }).length };
  }
  const sum = (names) => names.reduce((a, f) => ({ bytes: a.bytes + files[f].bytes, gz9: a.gz9 + files[f].gz9 }), { bytes: 0, gz9: 0 });
  const eagerNames = new Set();
  const walk = (out) => {
    const name = out.split("/").pop();
    if (eagerNames.has(name)) return;
    eagerNames.add(name);
    for (const i of metafile.outputs[out].imports) if (i.kind === "import-statement") walk(i.path);
  };
  walk(join(outdir, "sdk.js"));
  const eager = sum([...eagerNames]);
  const total = sum(Object.keys(files));
  sizes[cell] = { eager, lazy: { bytes: total.bytes - eager.bytes, gz9: total.gz9 - eager.gz9 }, total, files };
  console.log(`${cell.padEnd(14)} eager ${(eager.gz9 / 1024).toFixed(1).padStart(6)} KB gz  lazy ${((total.gz9 - eager.gz9) / 1024).toFixed(1).padStart(6)} KB gz  (${Object.keys(files).length} files)`);
}
await writeFile("dist/sizes.json", JSON.stringify(sizes, null, 2));
