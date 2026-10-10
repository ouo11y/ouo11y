/**
 * Local verification of the ingest path (ADR-0007) without rum-api: a Node HTTP stub that
 * behaves like rum-api's gateway (401 without `X-Ouo-Project-Token`, 200 otherwise) and logs
 * method, path and headers of everything the SDK sends through the real `fetch`.
 * Port 18082 is the one named in the Phase 8a plan; it falls back to an ephemeral port if busy.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { MemoryAsyncStorage } from "../src/session/storage";

const PREFERRED_PORT = 18082;
const TOKEN = "pt_dev_demo_0000000000000000";

interface LoggedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  status: number;
  body: string;
}

const logged: LoggedRequest[] = [];
let server: Server;
let baseUrl: string;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function listen(srv: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      const addr = srv.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : String(v ?? "");
    const token = headers["x-ouo-project-token"];
    const known = req.url?.startsWith("/ingest/otlp/v1/") || req.url === "/v1/replay/chunks";
    const status = !known ? 404 : !token ? 401 : token !== TOKEN ? 401 : 200;
    logged.push({ method: req.method ?? "", path: req.url ?? "", headers, status, body: body.toString("utf8") });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? "{}" : JSON.stringify({ error: status === 401 ? "missing or unknown project token" : "not found" }));
  });
  let port: number;
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch {
    port = await listen(server, 0);
  }
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Excerpt for the agent summary (stdout, since Vitest swallows console output from hooks). */
function dump(label: string): void {
  process.stdout.write(
    `[ingest-stub ${label}] ${baseUrl}\n` +
      logged.map((r) => `  ${r.method} ${r.path} -> ${r.status} x-ouo-project-token=${r.headers["x-ouo-project-token"] ?? "-"} content-type=${r.headers["content-type"] ?? "-"} bytes=${r.body.length}`).join("\n") +
      "\n",
  );
}

const g = globalThis as { __ouoSessionProcessState?: unknown };
beforeEach(() => {
  logged.length = 0;
  delete g.__ouoSessionProcessState;
});
afterEach(async () => {
  await (getRUM() as RUMInternal | undefined)?._uninstall();
  delete g.__ouoSessionProcessState;
});

describe("SDK against a rum-api ingest stub (real fetch)", () => {
  it("traces and logs arrive on the ingest routes with the project token and are accepted", async () => {
    const rum = initRUM({
      endpoint: `${baseUrl}/`,
      projectToken: TOKEN,
      service: { name: "mobile-store", version: "2.3.0", environment: "test" },
      storage: new MemoryAsyncStorage(),
    }) as RUMInternal;
    await rum.ready;
    // One app request (a span) to the stub's unknown route, plus events (logs).
    await fetch(`${baseUrl}/api/products`);
    rum.addEvent("cart.added", { "product.id": "p-1" });
    await rum.flush();

    const exports = logged.filter((r) => r.path.startsWith("/ingest/otlp/"));
    const paths = new Set(exports.map((r) => r.path));
    expect(paths).toEqual(new Set(["/ingest/otlp/v1/traces", "/ingest/otlp/v1/logs"]));
    for (const r of exports) {
      expect(r.method).toBe("POST");
      expect(r.status).toBe(200);
      expect(r.headers["x-ouo-project-token"]).toBe(TOKEN);
      expect(r.headers["content-type"]).toBe("application/json");
    }
    const traces = exports.find((r) => r.path.endsWith("/traces"))!;
    expect(traces.body).toContain('"name":"HTTP GET"');
    expect(traces.body).toContain(`"stringValue":"${rum.session.id()}"`);
    const logs = exports.find((r) => r.path.endsWith("/logs"))!;
    expect(logs.body).toContain("session.start");
    expect(logs.body).toContain("cart.added");
    // The export requests themselves were not traced (no span for /ingest/otlp/...).
    expect(traces.body).not.toContain("/ingest/otlp/");
    // The app request reached the stub without a token (it is not an ingest route).
    const app = logged.find((r) => r.path === "/api/products")!;
    expect(app.headers["x-ouo-project-token"]).toBeUndefined();
    dump("accepted");
  });

  it("the stub rejects a wrong token with 401, like rum-api", async () => {
    const rum = initRUM({
      endpoint: baseUrl,
      projectToken: "pt_unknown",
      service: { name: "mobile-store", version: "2.3.0", environment: "test" },
      storage: new MemoryAsyncStorage(),
    }) as RUMInternal;
    await rum.ready;
    await rum.flush();
    const logs = logged.filter((r) => r.path === "/ingest/otlp/v1/logs");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((r) => r.status === 401)).toBe(true);
    expect(logs[0]!.headers["x-ouo-project-token"]).toBe("pt_unknown");
    dump("rejected");
  });
});
