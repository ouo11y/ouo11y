// Step 1 of the plugin BFF checks (run.mjs, clearance-idp.mjs): @ouo11y/browser (replay.mode
// structure/dom) records a page in Chromium, with setUser, and sends telemetry and replay
// chunks to the collector. Returns the session id, the page's marker and the user id.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function record(browser, { otlp, project, token }) {
  const marker = randomBytes(4).toString("hex");
  const user = `e2e-user-${marker}`;
  const out = path.join(HERE, "build");
  fs.mkdirSync(out, { recursive: true });
  const sdkSrc = env.OUO_BROWSER_SDK_SRC ? path.resolve(env.OUO_BROWSER_SDK_SRC) : null;
  await build({
    entryPoints: [path.join(HERE, "page/entry.js")], bundle: true, format: "iife", target: "es2022",
    outfile: path.join(out, "page.js"), logLevel: "warning",
    ...(sdkSrc ? { alias: { "@ouo11y/browser": sdkSrc }, nodePaths: [path.join(REPO, "node_modules"), path.join(REPO, "sdk/browser/node_modules")] } : {}),
  });
  const cfg = JSON.stringify({ endpoint: otlp, projectId: project, projectToken: token, user });
  const html = fs.readFileSync(path.join(HERE, "page/index.html"), "utf8").replace("__CONFIG__", cfg).replace("__MARKER__", marker);
  const js = fs.readFileSync(path.join(out, "page.js"));
  const server = http.createServer((req, res) => {
    if (req.url === "/page.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const page = await browser.newPage();
  try {
    await page.goto(`http://localhost:${server.address().port}`);
    await page.waitForFunction(() => window.ouo?.getSessionId());
    const session = await page.evaluate(() => window.ouo.getSessionId());
    for (let i = 0; i < 5; i++) {
      await page.click("#add");
      await sleep(700);
    }
    await page.evaluate(() => window.ouo.shutdown()); // flushes and closes the replay stream
    await sleep(1000);
    console.log(`recorded session ${session} (marker ${marker}, SDK ${sdkSrc ?? "@ouo11y/browser 0.4.0 from npm"})`);
    return { session, marker, user, sdk: sdkSrc ?? "@ouo11y/browser 0.4.0 (npm)" };
  } finally {
    await page.close();
    server.close();
  }
}
