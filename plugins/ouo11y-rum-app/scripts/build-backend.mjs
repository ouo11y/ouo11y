// Builds the Go backend (pkg/, ADR-0023) of the nested datasource (ADR-0024) into
// dist/datasource/ for the platforms Grafana runs it on in our stacks:
// gpx_ouo11y-rum-datasource_linux_{amd64,arm64}. Run after webpack, which keeps
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
  const out = `dist/datasource/gpx_ouo11y-rum-datasource_${goos}_${goarch}`;
  const args = ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "./pkg"];
  const env = { CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch };
  console.log(`backend: ${out}${hasGo ? "" : ` (in ${GO_IMAGE})`}`);
  if (hasGo) {
    execFileSync("go", args, { cwd: plugin, stdio: "inherit", env: { ...process.env, ...env } });
  } else {
    // The module replaces ouo-go with ../../libs/ouo-go, so the whole repository is mounted.
    // Module and build caches are host directories owned by this user, kept between builds.
    // One directory per user: the CI runners are separate users sharing /tmp.
    const cache = path.join(os.tmpdir(), `ouo-go-cache-${process.getuid()}`);
    fs.mkdirSync(path.join(cache, "mod"), { recursive: true });
    fs.mkdirSync(path.join(cache, "build"), { recursive: true });
    // Rootless Docker (the CI runners) maps container root to this user, so run as root there;
    // elsewhere run as this user so dist/ stays ours.
    const rootless = /rootless/.test(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8" }));
    const user = rootless ? [] : ["-u", `${process.getuid()}:${process.getgid()}`];
    execFileSync("docker", [
      "run", "--rm", "-v", `${repo}:/src`, "-v", `${cache}:/gocache`, "-e", "GOMODCACHE=/gocache/mod", "-e", "GOCACHE=/gocache/build",
      "-w", "/src/plugins/ouo11y-rum-app", ...user,
      "-e", "GOFLAGS=-buildvcs=false",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      GO_IMAGE, "go", ...args,
    ], { stdio: "inherit" });
  }
}
