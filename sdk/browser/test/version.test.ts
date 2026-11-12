import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/version";

// release-please bumps package.json and src/version.ts together (.github/release-please/config.json,
// extra-files); this catches a version.ts that lost its marker or a hand edit of one side.
describe("SDK_VERSION", () => {
  it("equals the package.json version (reported as ouo.sdk.version)", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe("spec version (VER-2, VER-3)", () => {
  it("the release states the spec version it implements, in code and in the README", async () => {
    const { SPEC_VERSION, SCHEMA_URL } = await import("../src/version");
    expect(SPEC_VERSION).toBe("0.1.0-draft");
    expect(SCHEMA_URL).toBe("https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev");
    expect(readFileSync(join(__dirname, "../README.md"), "utf8")).toContain(`spec version \`${SPEC_VERSION}\``);
  });

  it("no unload or beforeunload handler and no synchronous XHR anywhere in the source (LIF-6, ERR-4)", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "../src"));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      // Code only: comments may name what the code must not do.
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/["'`](before)?unload["'`]/);
      expect(src, f).not.toMatch(/\.open\([^)]*,\s*false\s*\)/);
      expect(src, f).not.toMatch(/localStorage\.clear\(|document\.cookie/);
      expect(src, f).not.toMatch(/console\.error/);
    }
  });
});
