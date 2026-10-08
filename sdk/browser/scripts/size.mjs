// Prints raw and gzip sizes of the built entry and chunks.
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
for (const f of readdirSync("dist").filter((f) => f.endsWith(".js"))) {
  const buf = readFileSync(`dist/${f}`);
  console.log(`${f.padEnd(28)} raw ${(buf.length / 1024).toFixed(1).padStart(7)} KB   gzip ${(gzipSync(buf, { level: 9 }).length / 1024).toFixed(1).padStart(6)} KB`);
}
