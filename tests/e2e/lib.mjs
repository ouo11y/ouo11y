// Configuration and helpers shared by the e2e scripts (scenario.mjs, mobile/conformance.mjs).
// Node 24, no dependencies. The variables are the ones deploy/scripts/e2e.sh and
// `deploy/envs/ouo-env env <env>` export; the defaults are compose.yaml's ports.

const env = process.env;
export const RUM = (env.OUO_RUM_API_URL ?? env.OUO_RUM_API ?? `http://localhost:${env.OUO_RUM_API_PORT ?? 8080}`).replace(/\/$/, "");
export const OTLP = (env.OUO_OTLP_URL ?? `http://localhost:${env.OUO_OTLP_HTTP_PORT ?? 4318}`).replace(/\/$/, "");
export const REPLAY = (env.OUO_REPLAY_URL ?? `http://localhost:${env.OUO_REPLAY_PORT ?? 4319}`).replace(/\/$/, "");
export const PROJECT_TOKEN = env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000";
export const PROJECT_ID = env.OUO_PROJECT_ID ?? "demo";
export const BASIC = "Basic " + (env.OUO_PROJECT_BASIC || Buffer.from(`${PROJECT_ID}:${PROJECT_TOKEN}`, "utf8").toString("base64"));
export const READ_TOKEN = env.OUO_READ_TOKEN ?? "rt_dev_0000000000000000";
// Muninn, the replay store (ADR-0019): `ouo-env up <env> --muninn` exports OUO_MUNINN_URL; compose.muninn.yaml's defaults otherwise.
export const MUNINN = (env.OUO_MUNINN_URL ?? `http://localhost:${env.OUO_MUNINN_PORT ?? 3400}`).replace(/\/$/, "");
export const MUNINN_READ_TOKEN = env.OUO_MUNINN_READ_TOKEN ?? "mrt_dev_0000000000000000";
export const TEMPO_DS_UID = env.OUO_TEMPO_DS_UID ?? "tempo";
export const GRAFANA = (env.OUO_GRAFANA_URL ?? `http://localhost:${env.OUO_GRAFANA_PORT ?? 3000}`).replace(/\/$/, "");
export const GRAFANA_AUTH = env.OUO_GRAFANA_AUTH ?? "admin:testing567";
export const TIMEOUT_S = Number(env.OUO_E2E_TIMEOUT ?? 180);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A trace id in the form Tempo returns it: Tempo's search API drops leading zeros (a 32-hex
 * id starting with "0" comes back as 31 chars), and both forms resolve. Compare ids through
 * this, never raw.
 */
export const normTraceId = (id) => String(id).toLowerCase().replace(/^0+/, "");

export const grafanaAuth = () => ({ authorization: "Basic " + Buffer.from(GRAFANA_AUTH).toString("base64") });

/** Headers for a rum-api read: the read token when one is configured (ADR-0007 section 6). */
export function readHeaders() {
  return READ_TOKEN ? { authorization: `Bearer ${READ_TOKEN}` } : {};
}

export async function getJSON(url, headers = {}) {
  // rum-api reads carry the read token; Grafana calls carry basic auth; the token never goes elsewhere.
  const auth = url.startsWith(RUM + "/")
    ? readHeaders()
    : url.startsWith(GRAFANA + "/")
      ? grafanaAuth()
      : url.startsWith(MUNINN + "/") && MUNINN_READ_TOKEN
        ? { authorization: `Bearer ${MUNINN_READ_TOKEN}` }
        : {};
  const res = await fetch(url, { headers: { ...auth, ...headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function pollUntil(label, fn, timeoutS = TIMEOUT_S, everyMs = 3000) {
  const deadline = Date.now() + timeoutS * 1000;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last.done) return last.value;
    } catch (err) {
      last = { error: String(err) };
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timeout after ${timeoutS}s; last: ${JSON.stringify(last).slice(0, 500)}`);
    }
    await sleep(everyMs);
  }
}

export function table(rows) {
  const cols = Object.keys(rows[0]);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => cols.map((c, i) => String(r[c]).padEnd(width[i])).join("  ");
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(width.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}
