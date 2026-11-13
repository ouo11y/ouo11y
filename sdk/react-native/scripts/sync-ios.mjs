// Copies the Swift (and C, Objective-C) sources of sdk/ios into sdk/react-native/ios so the CocoaPods specs
// (OuoReplayCore, OuoReplay, OuoReplayObjC, OuoReplaySentryCore, OuoReplaySentryCoreObjC, OuoCrashCore, OuoCrash, OuoVitalsCore, OuoVitals .podspec) can glob them: CocoaPods does not accept
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
const sourceFile = (p) => p.endsWith(".swift") || p.endsWith(".c") || p.endsWith(".m") || p.endsWith(".h");
const countFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : sourceFile(e.name) ? 1 : 0), 0);
for (const module of ["OuoReplayCore", "OuoReplay", "OuoReplayObjC", "OuoReplaySentryCore", "OuoReplaySentryCoreObjC", "OuoCrashCore", "OuoCrash", "OuoVitalsCore", "OuoVitals"]) {
  const from = join(source, module);
  const to = join(target, module);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: (p) => statSync(p).isDirectory() || sourceFile(p) });
  files += countFiles(to);
}
// The notices of the code adapted from sentry-cocoa (MIT) travel with its copy.
for (const notice of ["NOTICE", "THIRD_PARTY_NOTICES"]) cpSync(resolve(source, "..", notice), join(target, notice));
console.log(`[ouo] sync-ios: ${files} source files copied into ${target}`);
