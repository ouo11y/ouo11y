// Copies the Swift sources of sdk/ios into sdk/react-native/ios so the CocoaPods specs
// (OuoReplayCore.podspec, OuoReplay.podspec) can glob them: CocoaPods does not accept
// source_files outside the podspec directory. sdk/ios stays the source of truth; the copies
// are gitignored and refreshed by `npm run build`.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../ios/Sources");
const target = resolve(here, "../ios");

if (!existsSync(source)) {
  console.error(`[ouo] sync-ios: ${source} not found (expected the sdk/ios Swift package)`);
  process.exit(1);
}

let files = 0;
for (const module of ["OuoReplayCore", "OuoReplay"]) {
  const from = join(source, module);
  const to = join(target, module);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: (p) => statSync(p).isDirectory() || p.endsWith(".swift") });
  files += readdirSync(to).filter((f) => f.endsWith(".swift")).length;
}
console.log(`[ouo] sync-ios: ${files} Swift files copied into ${target}`);
