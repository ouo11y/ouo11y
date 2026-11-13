#!/usr/bin/env node
// Loads a built ouo-web (examples/ouo-web/dist after `ouo-sourcemaps inject`) in headless
// Chromium, triggers the Chaos page's render error, and writes the exception record that
// @ouo11y/browser sends: exception.stacktrace, ouo.exception.debug_ids and service.version.
// The page, the backend and the OTLP endpoint are all answered by Playwright routes, so the
// run needs no stack and opens no port.
//
//   node capture.mjs <dist dir> <out dir>      (after `npm ci` at the repo root)
import { chromium } from "playwright";
import { gunzipSync } from "node:zlib";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";

const [dist, out] = process.argv.slice(2);
const APP = "http://localhost:14173"; // nothing listens there
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const records = [];
const anyValue = (v) => v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue ?? JSON.stringify(v);
const attrs = (list = []) => Object.fromEntries(list.map((a) => [a.key, anyValue(a.value)]));

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("**/*", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (req.method() === "POST" && url.pathname.endsWith("/v1/logs")) {
    try {
      // The SDK gzips its OTLP/JSON bodies.
      const body = req.postDataBuffer() ?? Buffer.alloc(0);
      const json = (await req.headerValue("content-encoding")) === "gzip" ? gunzipSync(body) : body;
      for (const rl of JSON.parse(json.toString("utf8")).resourceLogs ?? [])
        for (const sl of rl.scopeLogs ?? [])
          for (const lr of sl.logRecords ?? []) records.push({ resource: attrs(rl.resource?.attributes), ...attrs(lr.attributes), eventName: lr.eventName });
    } catch {
      // not a logs request this script can read
    }
  }
  // Everything that is not the app (the OTLP endpoint, the demo backend) gets an empty 200.
  if (url.origin !== APP) return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: "[]" });
  const file = extname(url.pathname) ? url.pathname : "/index.html";
  try {
    return route.fulfill({ status: 200, contentType: types[extname(file)] ?? "application/octet-stream", body: await readFile(join(dist, file)) });
  } catch {
    return route.fulfill({ status: 404, body: "" });
  }
});
await page.goto(APP + "/");
await page.getByRole("navigation").getByRole("link", { name: "Chaos", exact: true }).click();
await page.locator('[data-chaos="render-error"]').click();
await page.getByTestId("page-failed").waitFor();
for (let i = 0; i < 40 && !records.some((r) => "exception.stacktrace" in r); i++) await page.waitForTimeout(500);
await browser.close();

const ex = records.find((r) => typeof r["exception.stacktrace"] === "string" && /chaos: render error/.test(r["exception.message"] ?? ""));
if (!ex) {
  console.error(`no exception record among ${records.length} log records`);
  process.exit(1);
}
await mkdir(out, { recursive: true });
await writeFile(join(out, "stack.txt"), ex["exception.stacktrace"] + "\n");
await writeFile(join(out, "debug-ids.json"), ex["ouo.exception.debug_ids"] ?? "{}");
await writeFile(join(out, "record.json"), JSON.stringify(ex, null, 2) + "\n");
console.log(`captured ${ex["exception.type"]}: ${ex["exception.message"]} (service.version ${ex.resource["service.version"]})`);
