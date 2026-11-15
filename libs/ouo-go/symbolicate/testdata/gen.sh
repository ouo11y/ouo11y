#!/usr/bin/env bash
# Regenerates app.min.js / app.min.js.map and the recorded stacks from src/app.ts
# (esbuild from the repo's node_modules, then Node runs the bundle).
set -euo pipefail
cd "$(dirname "$0")"
root="$(cd ../../../.. && pwd)"
"$root/node_modules/.bin/esbuild" src/app.ts --bundle --minify --format=iife --sourcemap --sources-content=true --outfile=app.min.js
node -e '
  require("./app.min.js");
  try { globalThis.run([1, -2]); } catch (e) { require("fs").writeFileSync("stack-v8.txt", e.stack.replaceAll("file://" + process.cwd() + "/", "https://shop.example/assets/").split("\n").filter((l, i) => i === 0 || l.includes("shop.example")).join("\n") + "\n    at native\n"); }
'
