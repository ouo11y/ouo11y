// Copies the Kotlin sources of sdk/android (replay-core, replay, signals-core, signals) into sdk/react-native/android/vendor
// so the Expo module compiles them inside the app's build: an npm package cannot reach a Gradle project
// outside itself. sdk/android stays the source of truth; the copies are gitignored and refreshed by
// `npm run build`, like sync-ios.mjs does for the Swift sources.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../android");
const target = resolve(here, "../android/vendor");

if (!existsSync(source)) {
  console.error(`[ouo] sync-android: ${source} not found (expected the sdk/android Gradle project)`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
let files = 0;
const count = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : e.name.endsWith(".kt") ? 1 : 0), 0);
for (const module of ["replay-core", "replay", "signals-core", "signals"]) {
  cpSync(join(source, module, "src/main/kotlin"), target, { recursive: true, filter: (p) => statSync(p).isDirectory() || p.endsWith(".kt") });
}
files = count(target);
console.log(`[ouo] sync-android: ${files} Kotlin files copied into ${target}`);
