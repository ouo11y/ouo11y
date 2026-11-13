// Builds the plugin's Go backend (pkg/, ADR-0023) into dist/ for the platforms Grafana runs
// it on in our stacks: gpx_ouo11y-rum-app_linux_{amd64,arm64}. Run after webpack, which keeps
// these files when it cleans dist/. Uses the local Go toolchain when there is one, otherwise
// the golang image (CI jobs that only set up Node, and machines without Go).
//
//   node scripts/build-backend.mjs            both linux platforms
//   OUO_BACKEND_PLATFORMS=linux/arm64 node scripts/build-backend.mjs
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(plugin, "../..");
// The image matches the go directive of go.mod (grafana-plugin-sdk-go sets its minimum).
const GO_IMAGE = `golang:${/^go (\S+)$/m.exec(fs.readFileSync(path.join(plugin, "go.mod"), "utf8"))[1]}`;
const platforms = (process.env.OUO_BACKEND_PLATFORMS ?? "linux/amd64,linux/arm64").split(",").map((p) => p.trim()).filter(Boolean);

const hasGo = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;
for (const p of platforms) {
  const [goos, goarch] = p.split("/");
  const out = `dist/gpx_ouo11y-rum-app_${goos}_${goarch}`;
  const args = ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "./pkg"];
  const env = { CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch };
  console.log(`backend: ${out}${hasGo ? "" : ` (in ${GO_IMAGE})`}`);
  if (hasGo) {
    execFileSync("go", args, { cwd: plugin, stdio: "inherit", env: { ...process.env, ...env } });
  } else {
    // The module replaces ouo-go with ../../libs/ouo-go, so the whole repository is mounted.
    // The module cache is a host directory owned by this user, kept between builds.
    const cache = path.join(os.tmpdir(), "ouo-gomod-cache");
    fs.mkdirSync(cache, { recursive: true });
    execFileSync("docker", [
      "run", "--rm", "-v", `${repo}:/src`, "-v", `${cache}:/gomod`, "-e", "GOMODCACHE=/gomod",
      "-w", "/src/plugins/ouo11y-rum-app", "-u", `${process.getuid()}:${process.getgid()}`,
      "-e", "GOCACHE=/tmp/gocache", "-e", "GOFLAGS=-buildvcs=false",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      GO_IMAGE, "go", ...args,
    ], { stdio: "inherit" });
  }
}
