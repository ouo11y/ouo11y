// Prints raw and gzip sizes of the built entries and chunks. With --check, fails when a file's
// gzip size exceeds its budget in size-budget.json (patterns match hashed chunk names) or when
// a built file has no budget at all.
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const check = process.argv.includes("--check");
const budgets = JSON.parse(readFileSync(new URL("../size-budget.json", import.meta.url), "utf8")).files;
const toRegExp = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
const rules = Object.entries(budgets).map(([pattern, kb]) => ({ pattern, re: toRegExp(pattern), kb }));

let failed = 0;
for (const f of readdirSync("dist").filter((f) => f.endsWith(".js"))) {
  const buf = readFileSync(`dist/${f}`);
  const gzip = gzipSync(buf, { level: 9 }).length / 1024;
  const rule = rules.find((r) => r.re.test(f));
  let verdict = "";
  if (check) {
    if (!rule) {
      verdict = "  FAIL no budget in size-budget.json";
      failed++;
    } else if (gzip > rule.kb) {
      verdict = `  FAIL over budget ${rule.kb.toFixed(1)} KB by ${(gzip - rule.kb).toFixed(1)} KB`;
      failed++;
    } else {
      verdict = `  ok (budget ${rule.kb.toFixed(1)} KB)`;
    }
  }
  console.log(`${f.padEnd(28)} raw ${(buf.length / 1024).toFixed(1).padStart(7)} KB   gzip ${gzip.toFixed(1).padStart(6)} KB${verdict}`);
}
if (check && failed) {
  console.error(`\n${failed} file(s) over the bundle-size budget (sdk/browser/size-budget.json)`);
  process.exit(1);
}
