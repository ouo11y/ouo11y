/**
 * Local verification of the ingest path (ADR-0007) without the collector: a Node HTTP stub that
 * behaves like `ouo-collector` with the `basicauth` extension (401 without a valid
 * `Authorization: Basic ...`, 200 otherwise) on the OTLP routes `/v1/traces`, `/v1/logs` and the
 * replay receiver's `/v1/replay/chunks`, and logs method, path and headers of everything the SDK
 * sends through the real `fetch`. Port 18082 is the one named in the Phase 8a plan; it falls back
 * to an ephemeral port if busy.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { MemoryAsyncStorage } from "../src/session/storage";

const PREFERRED_PORT = 18082;
const PROJECT_ID = "demo";
const TOKEN = "pt_dev_demo_0000000000000000";
/** What the collector's htpasswd line `demo:{SHA}...` accepts: Basic base64("demo:pt_dev_demo_..."). */
const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(`${PROJECT_ID}:${TOKEN}`).toString("base64")}`;

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
    const authorization = headers["authorization"];
    const known = req.url === "/v1/traces" || req.url === "/v1/logs" || req.url === "/v1/replay/chunks";
    const status = !known ? 404 : !authorization ? 401 : authorization !== EXPECTED_AUTHORIZATION ? 401 : 200;
    logged.push({ method: req.method ?? "", path: req.url ?? "", headers, status, body: body.toString("utf8") });
    res.writeHead(status, status === 401 ? { "content-type": "text/plain", "www-authenticate": 'Basic realm="ouo"' } : { "content-type": "application/json" });
    res.end(status === 200 ? "{}" : status === 401 ? "Unauthorized" : JSON.stringify({ error: "not found" }));
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
      logged.map((r) => `  ${r.method} ${r.path} -> ${r.status} authorization=${r.headers["authorization"] ?? "-"} content-type=${r.headers["content-type"] ?? "-"} bytes=${r.body.length}`).join("\n") +
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

describe("SDK against a collector stub with basicauth (real fetch)", () => {
  it("traces and logs arrive on the OTLP routes with the Basic credential and are accepted", async () => {
    const rum = initRUM({
      endpoint: `${baseUrl}/`,
      projectId: PROJECT_ID,
      projectToken: TOKEN,
      service: { name: "mobile-store", version: "2.3.0", environment: "test" },
      storage: new MemoryAsyncStorage(),
    }) as RUMInternal;
    await rum.ready;
    // One app request (a span) to the stub's unknown route, plus events (logs).
    await fetch(`${baseUrl}/api/products`);
    rum.addEvent("cart.added", { "product.id": "p-1" });
    await rum.flush();

    const exports = logged.filter((r) => r.path.startsWith("/v1/"));
    const paths = new Set(exports.map((r) => r.path));
    expect(paths).toEqual(new Set(["/v1/traces", "/v1/logs"]));
    for (const r of exports) {
      expect(r.method).toBe("POST");
      expect(r.status).toBe(200);
      expect(r.headers["authorization"]).toBe(EXPECTED_AUTHORIZATION);
      expect(r.headers["authorization"]).toBe("Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw");
      expect(r.headers["x-ouo-project-token"]).toBeUndefined();
      expect(r.headers["content-type"]).toBe("application/json");
    }
    const traces = exports.find((r) => r.path === "/v1/traces")!;
    expect(traces.body).toContain('"name":"HTTP GET"');
    expect(traces.body).toContain(`"stringValue":"${rum.session.id()}"`);
    const logs = exports.find((r) => r.path === "/v1/logs")!;
    expect(logs.body).toContain("session.start");
    expect(logs.body).toContain("cart.added");
    // The export requests themselves were not traced (no span for /v1/traces or /v1/logs).
    expect(traces.body).not.toContain("/v1/traces");
    expect(traces.body).not.toContain("/v1/logs");
    // The app request reached the stub without the credential (it is not an ingest route).
    const app = logged.find((r) => r.path === "/api/products")!;
    expect(app.headers["authorization"]).toBeUndefined();
    dump("accepted");
  });

  it("the stub rejects a wrong token with 401, like the collector's basicauth", async () => {
    const rum = initRUM({
      endpoint: baseUrl,
      projectId: PROJECT_ID,
      projectToken: "pt_unknown",
      service: { name: "mobile-store", version: "2.3.0", environment: "test" },
      storage: new MemoryAsyncStorage(),
    }) as RUMInternal;
    await rum.ready;
    await rum.flush();
    const logs = logged.filter((r) => r.path === "/v1/logs");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((r) => r.status === 401)).toBe(true);
    expect(logs[0]!.headers["authorization"]).toBe(`Basic ${Buffer.from("demo:pt_unknown").toString("base64")}`);
    dump("rejected");
  });

  it("_uninstall sends what its shutdown exports before it resolves (no request outlives the instance)", async () => {
    const rum = initRUM({
      endpoint: baseUrl,
      projectId: PROJECT_ID,
      projectToken: TOKEN,
      service: { name: "mobile-store", version: "2.3.0", environment: "test" },
      storage: new MemoryAsyncStorage(),
    }) as RUMInternal;
    await rum.ready;
    await rum.flush();
    // Recorded after the last flush, like a vitals stall on a loaded machine: only the provider
    // shutdown in _uninstall exports it.
    rum.addEvent("after.flush");
    await rum._uninstall();
    const late = logged.filter((r) => r.path === "/v1/logs" && r.body.includes("after.flush"));
    expect(late.map((r) => r.status)).toEqual([200]);
  });
});
