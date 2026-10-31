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
