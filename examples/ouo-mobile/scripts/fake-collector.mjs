#!/usr/bin/env node
// A fake OpenTelemetry Collector for verifying the mobile SDK without a stack (spec section 14:
// "a fake Collector that records requests and can inject any response"). Node only, no
// dependencies.
//
//   node scripts/fake-collector.mjs [--port 4318] [--out ./collector-out]
//                                   [--status 503] [--retry-after 2] [--fail-first 3]
//
// - Accepts POST /v1/logs and /v1/traces, JSON or protobuf, gzip or not. Answers 200 `{}`.
// - Faults: `--fail-first K` answers the first K requests with `--status` (default 503);
//   `--status N` alone answers every request with N; `--retry-after S` adds the header to
//   those answers. A request answered with a fault is counted, not recorded.
// - Replay: a protobuf log request whose scope is `ouo.replay` is decoded with the small reader
//   below. Each chunk body goes to `<out>/<stream>-<seq>.ndjson.gz` and one JSON line per record
//   (attributes, sizes) to `<out>/records.jsonl`. Every request, faulted or not, is one line of
//   `<out>/requests.jsonl` (path, status answered, sha256 of the raw body): a retry sends the same bytes.
// - `GET /__report` (JSON) and SIGINT (text, exit code 1 on a failed rule) give the verdict on
//   the rules of spec section 11 this can check, the telemetry event names seen, and whether the
//   replay records carry the telemetry's session.id (and ouo.view.id, once telemetry has one), and for each replay
//   request answered with a fault whether it was retried with the same bytes.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const REPLAY_SCOPE = "ouo.replay";
export const CHUNK_EVENT = "ouo.replay.chunk";
export const ENDED_EVENT = "ouo.replay.ended";
export const MAX_CHUNK_BYTES = 1024 * 1024;

// ---- protobuf: just enough to read an OTLP logs or traces request ----

/** Yields `[fieldNumber, wireType, value]`: a BigInt for varint and fixed, a Buffer for bytes. */
export function* fields(buf) {
  let i = 0;
  const varint = () => {
    let shift = 0n;
    let out = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("truncated varint");
      const b = buf[i++];
      out |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return out;
      shift += 7n;
      if (shift > 63n) throw new Error("varint too long");
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) yield [field, wire, varint()];
    else if (wire === 1) {
      if (i + 8 > buf.length) throw new Error("truncated fixed64");
      yield [field, wire, buf.readBigUInt64LE(i)];
      i += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      if (i + len > buf.length) throw new Error("truncated bytes");
      yield [field, wire, buf.subarray(i, i + len)];
      i += len;
    } else if (wire === 5) {
      if (i + 4 > buf.length) throw new Error("truncated fixed32");
      yield [field, wire, BigInt(buf.readUInt32LE(i))];
      i += 4;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
}

/** AnyValue as `{ type, value }`; `type` is string, bool, int, double, bytes, array, kvlist or empty. */
export function anyValue(buf) {
  for (const [field, wire, value] of fields(buf)) {
    if (field === 1 && wire === 2) return { type: "string", value: value.toString("utf8") };
    if (field === 2 && wire === 0) return { type: "bool", value: value !== 0n };
    if (field === 3 && wire === 0) return { type: "int", value: Number(BigInt.asIntN(64, value)) };
    if (field === 4 && wire === 1) {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(value);
      return { type: "double", value: b.readDoubleLE(0) };
    }
    if (field === 5 && wire === 2) return { type: "array", value: [...fields(value)].filter(([f]) => f === 1).map(([, , v]) => anyValue(v)) };
    if (field === 6 && wire === 2) return { type: "kvlist", value: keyValues([...fields(value)].filter(([f]) => f === 1).map(([, , v]) => v)) };
    if (field === 7 && wire === 2) return { type: "bytes", value: Buffer.from(value) };
  }
  return { type: "empty", value: undefined };
}

function keyValues(buffers) {
  const out = {};
  for (const kv of buffers) {
    let key = "";
    let value = { type: "empty", value: undefined };
    for (const [field, wire, v] of fields(kv)) {
      if (field === 1 && wire === 2) key = v.toString("utf8");
      else if (field === 2 && wire === 2) value = anyValue(v);
    }
    out[key] = value;
  }
  return out;
}

const plain = (attrs) => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, v.type === "bytes" ? `<${v.value.length} bytes>` : v.value]));

/**
 * ExportLogsServiceRequest (protobuf) as a flat list of records:
 * `{ resource, resourceSchemaUrl, scope: { name, version }, schemaUrl, eventName, timeUnixNano,
 *    observedTimeUnixNano, attributes: { key: { type, value } }, body: { type, value } }`.
 */
export function decodeLogsRequest(buf) {
  const records = [];
  for (const [f1, w1, resourceLogs] of fields(buf)) {
    if (f1 !== 1 || w1 !== 2) continue;
    let resource = {};
    let resourceSchemaUrl = "";
    const scopes = [];
    for (const [f, w, v] of fields(resourceLogs)) {
      if (f === 1 && w === 2) resource = keyValues([...fields(v)].filter(([x]) => x === 1).map(([, , kv]) => kv));
      else if (f === 2 && w === 2) scopes.push(v);
      else if (f === 3 && w === 2) resourceSchemaUrl = v.toString("utf8");
    }
    for (const scopeLogs of scopes) {
      const scope = { name: "", version: "" };
      let schemaUrl = "";
      const logRecords = [];
      for (const [f, w, v] of fields(scopeLogs)) {
        if (f === 1 && w === 2) {
          for (const [sf, sw, sv] of fields(v)) {
            if (sf === 1 && sw === 2) scope.name = sv.toString("utf8");
            else if (sf === 2 && sw === 2) scope.version = sv.toString("utf8");
          }
        } else if (f === 2 && w === 2) logRecords.push(v);
        else if (f === 3 && w === 2) schemaUrl = v.toString("utf8");
      }
      for (const lr of logRecords) {
        const record = { resource, resourceSchemaUrl, scope, schemaUrl, eventName: "", timeUnixNano: 0n, observedTimeUnixNano: 0n, attributes: {}, body: { type: "empty", value: undefined } };
        const attrs = [];
        for (const [f, w, v] of fields(lr)) {
          if (f === 1 && w === 1) record.timeUnixNano = v;
          else if (f === 11 && w === 1) record.observedTimeUnixNano = v;
          else if (f === 5 && w === 2) record.body = anyValue(v);
          else if (f === 6 && w === 2) attrs.push(v);
          else if (f === 12 && w === 2) record.eventName = v.toString("utf8");
        }
        record.attributes = keyValues(attrs);
        if (!record.eventName && record.attributes["event.name"]?.type === "string") record.eventName = record.attributes["event.name"].value;
        records.push(record);
      }
    }
  }
  return records;
}

/** Span names of an ExportTraceServiceRequest (protobuf). */
export function decodeSpanNames(buf) {
  const names = [];
  for (const [f1, w1, rs] of fields(buf)) {
    if (f1 !== 1 || w1 !== 2) continue;
    for (const [f2, w2, ss] of fields(rs)) {
      if (f2 !== 2 || w2 !== 2) continue;
      for (const [f3, w3, span] of fields(ss)) {
        if (f3 !== 2 || w3 !== 2) continue;
        for (const [f4, w4, v] of fields(span)) if (f4 === 5 && w4 === 2) names.push(v.toString("utf8"));
      }
    }
  }
  return names;
}

// ---- the rules of spec section 11 this collector can check ----

/** Spec 11.3: the attributes every chunk MUST carry, with their types. */
export const CHUNK_MUST = {
  "session.id": "string",
  "ouo.replay.id": "string",
  "ouo.replay.stream.id": "string",
  "ouo.replay.segment.index": "int",
  "ouo.replay.sequence": "int",
  "ouo.replay.keyframe": "bool",
  "ouo.replay.start_time": "int",
  "ouo.replay.end_time": "int",
  "ouo.replay.format": "string",
  "ouo.replay.encoding": "string",
  "ouo.replay.sha256": "string",
  "ouo.replay.byte_size": "int",
  "ouo.replay.masked": "bool",
  "ouo.replay.mode": "string",
};
/** Spec 11.5: the attributes every `ouo.replay.ended` MUST carry (`last_sequence` when a chunk exists). */
export const ENDED_MUST = { "session.id": "string", "ouo.replay.id": "string", "ouo.replay.stream.id": "string", "ouo.replay.end_state": "string", "ouo.replay.end_reason": "string" };
const TRIGGERS = ["error", "crash", "anr", "hang", "manual"];
const END_REASONS = ["session_end", "stop", "consent", "pagehide", "background_kill", "crash", "max_size", "error"];

export const RULES = {
  one_chunk_per_request: "TRN-5: a replay request holds exactly one log record",
  no_content_encoding: "8.1: no Content-Encoding on a replay request (the body is compressed by the format layer)",
  chunk_attributes: "RPL-13: every MUST attribute of 11.3 is present and typed; no ouo.replay.ref (RPL-14)",
  body_size: "a chunk body is at most 1 MiB",
  hash_and_size: "RPL-12: ouo.replay.sha256 and ouo.replay.byte_size match the body received",
  body_decodes: "the body decodes (gzip when ouo.replay.encoding says so) and every line is JSON with `t` and `type`",
  sequence: "per stream the sequences are 0, 1, 2, ... with no gap",
  keyframe: "the first chunk of each segment has keyframe=true and starts with a `frame` event",
  ended: "RPL-20, RPL-26: one ouo.replay.ended per finished stream, MUST attributes present, last_sequence is the highest sequence seen",
  same_session: "every replay record's session.id is one the telemetry (logs, spans) of this collector carries",
  view_ids: "every chunk's ouo.view.id is one the telemetry of this collector carries",
};

export function createCollector(options = {}) {
  const out = options.out;
  if (out) mkdirSync(out, { recursive: true });
  const state = {
    requests: 0,
    faults: 0,
    /** Replay requests answered with a fault: `{ request, sha256, retried }`, `retried` set when the same request (event, stream, sequence) is accepted later. */
    faulted: [],
    /** Requests accepted, by path. */
    accepted: { "/v1/logs": 0, "/v1/traces": 0 },
    /** Telemetry (not replay) event names and span names, with counts. */
    events: {},
    spans: {},
    /** session.id and ouo.view.id values on telemetry records and spans. */
    sessions: new Set(),
    /** Telemetry session.id values with how many records carried each, for the report. */
    sessionCounts: {},
    views: new Set(),
    /** session.id and ouo.view.id values on replay records. */
    replaySessions: new Set(),
    replayViews: new Set(),
    /** stream id -> { chunks: Map<seq, chunk>, duplicates, ended: [] } */
    streams: new Map(),
    failures: Object.fromEntries(Object.keys(RULES).map((r) => [r, []])),
    checked: Object.fromEntries(Object.keys(RULES).map((r) => [r, 0])),
  };
  const fail = (rule, message) => {
    if (state.failures[rule].length < 50) state.failures[rule].push(message);
  };
  const check = (rule, ok, message) => {
    state.checked[rule]++;
    if (!ok) fail(rule, message);
    return ok;
  };
  const stream = (id) => {
    let s = state.streams.get(id);
    if (!s) state.streams.set(id, (s = { chunks: new Map(), duplicates: 0, ended: [] }));
    return s;
  };
  const count = (table, name) => (table[name] = (table[name] ?? 0) + 1);
  const typed = (attrs, must, what) => {
    const problems = [];
    for (const [key, type] of Object.entries(must)) {
      const a = attrs[key];
      if (!a) problems.push(`${key} missing`);
      else if (a.type !== type) problems.push(`${key} is ${a.type}, not ${type}`);
      else if (type === "string" && a.value === "") problems.push(`${key} is empty`);
    }
    return problems.length ? `${what}: ${problems.join("; ")}` : undefined;
  };

  function chunk(record, headers) {
    const a = record.attributes;
    const id = a["ouo.replay.stream.id"]?.value ?? "?";
    const seq = a["ouo.replay.sequence"]?.value;
    const what = `stream ${id} seq ${seq}`;
    const problem = typed(a, CHUNK_MUST, what);
    if (a["session.id"]?.type === "string") state.replaySessions.add(a["session.id"].value);
    if (a["ouo.view.id"]?.type === "string") state.replayViews.add(a["ouo.view.id"].value);
    const extras = [];
    if (a["ouo.replay.ref"]) extras.push("ouo.replay.ref is set by an SDK");
    const mode = a["ouo.replay.mode"]?.value;
    if (mode !== undefined && mode !== "session" && mode !== "buffer") extras.push(`ouo.replay.mode is "${mode}"`);
    if (mode === "buffer" && !TRIGGERS.includes(a["ouo.replay.trigger"]?.value)) extras.push(`ouo.replay.trigger is "${a["ouo.replay.trigger"]?.value}" in buffer mode`);
    check("chunk_attributes", !problem && extras.length === 0, [problem, ...extras.map((e) => `${what}: ${e}`)].filter(Boolean).join("; "));
    check("no_content_encoding", !headers["content-encoding"], `${what}: Content-Encoding: ${headers["content-encoding"]}`);

    const body = record.body.type === "bytes" ? record.body.value : undefined;
    if (!check("body_decodes", body !== undefined, `${what}: the body is ${record.body.type}, not bytes`)) return;
    check("body_size", body.length <= MAX_CHUNK_BYTES, `${what}: body is ${body.length} bytes`);
    const sha = createHash("sha256").update(body).digest("hex");
    check("hash_and_size", sha === a["ouo.replay.sha256"]?.value && body.length === a["ouo.replay.byte_size"]?.value, `${what}: sha256 ${a["ouo.replay.sha256"]?.value} / byte_size ${a["ouo.replay.byte_size"]?.value}, received ${sha} / ${body.length}`);

    const encoding = a["ouo.replay.encoding"]?.value;
    let firstType;
    let lines = 0;
    try {
      const text = (encoding === "gzip" ? gunzipSync(body) : body).toString("utf8");
      for (const line of text.split("\n")) {
        if (line === "") continue;
        const event = JSON.parse(line);
        if (typeof event.t !== "number" || typeof event.type !== "string") throw new Error(`line ${lines + 1} has no numeric t or no type`);
        if (lines === 0) firstType = event.type;
        lines++;
      }
      check("body_decodes", lines > 0, `${what}: the body has no event`);
    } catch (err) {
      check("body_decodes", false, `${what}: ${err.message}`);
    }

    const s = stream(id);
    if (typeof seq === "number") {
      if (s.chunks.has(seq)) s.duplicates++; // at-least-once delivery: a retry, not an error
      s.chunks.set(seq, { segment: a["ouo.replay.segment.index"]?.value, keyframe: a["ouo.replay.keyframe"]?.value, firstType, bytes: body.length, lines });
    }
    if (out) {
      writeFileSync(join(out, `${String(id).replace(/[^0-9a-zA-Z_-]/g, "_")}-${seq}.ndjson${encoding === "gzip" ? ".gz" : ""}`), body);
      appendFileSync(join(out, "records.jsonl"), `${JSON.stringify({ event: CHUNK_EVENT, attributes: plain(a), bodyBytes: body.length, lines, firstType, resource: plain(record.resource), scope: record.scope, schemaUrl: record.schemaUrl || record.resourceSchemaUrl })}\n`);
    }
  }

  function ended(record) {
    const a = record.attributes;
    const id = a["ouo.replay.stream.id"]?.value ?? "?";
    const problem = typed(a, ENDED_MUST, `ended ${id}`);
    if (a["session.id"]?.type === "string") state.replaySessions.add(a["session.id"].value);
    const reason = a["ouo.replay.end_reason"]?.value;
    const stateValue = a["ouo.replay.end_state"]?.value;
    const extras = [];
    if (reason !== undefined && !END_REASONS.includes(reason)) extras.push(`end_reason "${reason}"`);
    if (stateValue !== undefined && stateValue !== "complete" && stateValue !== "partial") extras.push(`end_state "${stateValue}"`);
    if (problem || extras.length) fail("ended", [problem, ...extras.map((e) => `ended ${id}: ${e}`)].filter(Boolean).join("; "));
    stream(id).ended.push({ lastSequence: a["ouo.replay.last_sequence"]?.value, endState: stateValue, endReason: reason });
    if (out) appendFileSync(join(out, "records.jsonl"), `${JSON.stringify({ event: ENDED_EVENT, attributes: plain(a) })}\n`);
  }

  /** Notes the session.id and ouo.view.id of a telemetry record or span (`get(key)` is its string value). */
  const ids = (get) => {
    const session = get("session.id");
    const view = get("ouo.view.id");
    if (typeof session === "string" && session) {
      state.sessions.add(session);
      count(state.sessionCounts, session);
    }
    if (typeof view === "string" && view) state.views.add(view);
  };
  const jsonAttr = (attrs) => (key) => attrs?.find((x) => x.key === key)?.value?.stringValue;

  /** `"<event> <stream> <sequence>"` for a replay request (protobuf logs), else undefined. Never throws. */
  function replayRequest(path, headers, raw) {
    try {
      if (path !== "/v1/logs") return undefined;
      const body = String(headers["content-encoding"] ?? "").toLowerCase() === "gzip" ? gunzipSync(raw) : raw;
      if (body.length === 0 || body[0] === 0x7b) return undefined;
      const r = decodeLogsRequest(body).find((x) => x.scope.name === REPLAY_SCOPE);
      return r ? `${r.eventName} ${r.attributes["ouo.replay.stream.id"]?.value} ${r.attributes["ouo.replay.sequence"]?.value ?? "-"}` : undefined;
    } catch {
      return undefined;
    }
  }

  /** A replay request answered with a fault, so that its retry can be compared byte for byte. */
  function faulted(path, headers, raw) {
    const request = replayRequest(path, headers, raw);
    if (request && state.faulted.length < 50) state.faulted.push({ request, sha256: createHash("sha256").update(raw).digest("hex"), retried: "not_yet" });
  }

  /** One accepted request. `body` is the raw body as received (still compressed). */
  function accept(path, headers, raw) {
    if (state.faulted.length) {
      const request = replayRequest(path, headers, raw);
      const sha = createHash("sha256").update(raw).digest("hex");
      for (const f of state.faulted) if (f.request === request && f.retried !== "same_bytes") f.retried = f.sha256 === sha ? "same_bytes" : "different_bytes";
    }
    const encoded = String(headers["content-encoding"] ?? "").toLowerCase();
    const body = encoded === "gzip" ? gunzipSync(raw) : raw;
    const type = String(headers["content-type"] ?? "").toLowerCase();
    const json = type.includes("json") || (body.length > 0 && body[0] === 0x7b);
    if (path === "/v1/traces") {
      if (json) {
        for (const rs of JSON.parse(body.toString("utf8")).resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const span of ss.spans ?? []) {
          count(state.spans, span.name);
          ids(jsonAttr(span.attributes));
        }
      } else for (const name of decodeSpanNames(body)) count(state.spans, name);
      return;
    }
    if (json) {
      for (const rl of JSON.parse(body.toString("utf8")).resourceLogs ?? []) {
        for (const sl of rl.scopeLogs ?? []) {
          for (const lr of sl.logRecords ?? []) {
            const name = lr.eventName || lr.attributes?.find((x) => x.key === "event.name")?.value?.stringValue || "(no event name)";
            // Replay is protobuf by spec (TRN-1): a JSON chunk cannot carry a bytes body untouched.
            if (sl.scope?.name === REPLAY_SCOPE) fail("body_decodes", `a replay record (${name}) arrived as JSON, not protobuf`);
            count(state.events, name);
            if (sl.scope?.name !== REPLAY_SCOPE) ids(jsonAttr(lr.attributes));
          }
        }
      }
      return;
    }
    const records = decodeLogsRequest(body);
    const replay = records.filter((r) => r.scope.name === REPLAY_SCOPE);
    for (const r of records) {
      if (r.scope.name === REPLAY_SCOPE) continue;
      count(state.events, r.eventName || "(no event name)");
      ids((key) => (r.attributes[key]?.type === "string" ? r.attributes[key].value : undefined));
    }
    if (replay.length === 0) return;
    check("one_chunk_per_request", records.length === 1, `a replay request holds ${records.length} records`);
    for (const r of replay) {
      if (r.eventName === CHUNK_EVENT) chunk(r, headers);
      else if (r.eventName === ENDED_EVENT) ended(r);
      else fail("chunk_attributes", `unknown event "${r.eventName}" in scope ${REPLAY_SCOPE}`);
    }
  }

  /** The verdict: per rule `pass`, `fail` (with the first failures) or `not_checked` (nothing to check it on). */
  function report() {
    const failures = Object.fromEntries(Object.entries(state.failures).map(([k, v]) => [k, [...v]]));
    const checked = { ...state.checked };
    const streams = [];
    for (const [id, s] of state.streams) {
      const seqs = [...s.chunks.keys()].sort((x, y) => x - y);
      const highest = seqs.length ? seqs[seqs.length - 1] : undefined;
      if (seqs.length) {
        checked.sequence++;
        const missing = [];
        for (let i = 0; i <= highest; i++) if (!s.chunks.has(i)) missing.push(i);
        if (missing.length) failures.sequence.push(`stream ${id}: missing sequence ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""} (highest ${highest})`);
        const firstOfSegment = new Map();
        for (const seq of seqs) {
          const c = s.chunks.get(seq);
          if (!firstOfSegment.has(c.segment)) firstOfSegment.set(c.segment, [seq, c]);
        }
        for (const [segment, [seq, c]] of firstOfSegment) {
          checked.keyframe++;
          if (c.keyframe !== true || c.firstType !== "frame") failures.keyframe.push(`stream ${id} segment ${segment}: its first chunk (seq ${seq}) has keyframe=${c.keyframe} and starts with "${c.firstType}"`);
        }
      }
      if (s.ended.length > 0) {
        checked.ended++;
        if (s.ended.length > 1) failures.ended.push(`stream ${id}: ${s.ended.length} ouo.replay.ended records`);
        const last = s.ended[0].lastSequence;
        if (highest !== undefined && last !== highest) failures.ended.push(`stream ${id}: last_sequence ${last}, highest sequence seen ${highest}`);
      }
      streams.push({ stream: id, chunks: seqs.length, highestSequence: highest ?? null, duplicates: s.duplicates, bytes: [...s.chunks.values()].reduce((n, c) => n + c.bytes, 0), ended: s.ended });
    }
    // Checked at report time, so the order replay and telemetry arrived in does not matter. Not
    // checked before any telemetry carried the id kind (a replay-only test, a telemetry outage).
    const crossCheck = (rule, replayIds, telemetryIds, what) => {
      if (telemetryIds.size === 0) return;
      for (const id of replayIds) {
        checked[rule]++;
        if (!telemetryIds.has(id)) failures[rule].push(`replay ${what} ${id} is on no telemetry record (telemetry has ${[...telemetryIds].slice(0, 5).join(", ")})`);
      }
    };
    crossCheck("same_session", state.replaySessions, state.sessions, "session.id");
    crossCheck("view_ids", state.replayViews, state.views, "ouo.view.id");
    const rules = Object.fromEntries(
      Object.keys(RULES).map((r) => [r, { rule: RULES[r], result: failures[r].length ? "fail" : checked[r] ? "pass" : "not_checked", checked: checked[r], failures: failures[r] }]),
    );
    const results = Object.values(rules).map((r) => r.result);
    return {
      verdict: results.includes("fail") ? "fail" : results.includes("pass") ? "pass" : "nothing_to_check",
      requests: state.requests,
      faultsInjected: state.faults,
      faultedReplay: state.faulted.map((f) => ({ ...f })),
      accepted: state.accepted,
      telemetry: { events: state.events, spans: state.spans, sessions: state.sessionCounts, views: state.views.size },
      streams,
      // A stream with chunks and no end record is still open (or its end was lost): not a failure here.
      openStreams: streams.filter((s) => s.ended.length === 0).map((s) => s.stream),
      rules,
    };
  }

  function handler(req, res) {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/__report") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(report(), null, 2));
      return;
    }
    if (req.method !== "POST" || (path !== "/v1/logs" && path !== "/v1/traces")) {
      res.writeHead(404).end();
      return;
    }
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      state.requests++;
      const failing = options.failFirst !== undefined ? state.requests <= options.failFirst : options.status !== undefined;
      if (out) {
        // Every request, answered with a fault or not: a retry must send the same bytes again (TRN-10).
        const raw = Buffer.concat(parts);
        appendFileSync(join(out, "requests.jsonl"), `${JSON.stringify({ n: state.requests, at: new Date().toISOString(), path, contentType: req.headers["content-type"] ?? "", status: failing ? (options.status ?? 503) : 200, sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length })}\n`);
      }
      if (failing) {
        state.faults++;
        faulted(path, req.headers, Buffer.concat(parts));
        res.writeHead(options.status ?? 503, options.retryAfter !== undefined ? { "retry-after": String(options.retryAfter) } : {});
        res.end();
        return;
      }
      try {
        accept(path, req.headers, Buffer.concat(parts));
        state.accepted[path]++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } catch (err) {
        // What cannot be read is a finding, and the sender gets the non-retryable answer a Collector would give.
        fail("body_decodes", `${path}: ${err.message}`);
        res.writeHead(400).end();
      }
    });
  }

  return { accept, report, handler, state };
}

export function formatReport(r) {
  const lines = [`verdict: ${r.verdict.toUpperCase()}`, `requests: ${r.requests} (faults injected: ${r.faultsInjected}; accepted logs ${r.accepted["/v1/logs"]}, traces ${r.accepted["/v1/traces"]})`];
  for (const [name, rule] of Object.entries(r.rules)) {
    lines.push(`  [${rule.result === "pass" ? "PASS" : rule.result === "fail" ? "FAIL" : " -- "}] ${name}: ${rule.rule} (${rule.checked} checked)`);
    for (const f of rule.failures.slice(0, 5)) lines.push(`         ${f}`);
  }
  for (const f of r.faultedReplay ?? []) lines.push(`  faulted replay request ${f.request}: retried ${f.retried}`);
  for (const s of r.streams) lines.push(`  stream ${s.stream}: ${s.chunks} chunk(s), highest sequence ${s.highestSequence}, ${s.bytes} bytes, ${s.duplicates} duplicate(s), ended: ${s.ended.length ? s.ended.map((e) => `${e.endState}/${e.endReason}/last=${e.lastSequence}`).join(", ") : "no"}`);
  lines.push(`  telemetry events: ${Object.entries(r.telemetry.events).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  lines.push(`  telemetry session.id: ${Object.entries(r.telemetry.sessions ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  lines.push(`  spans: ${Object.entries(r.telemetry.spans).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { port: 4318 };
  const number = (name, v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = number(a, argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--status") out.status = number(a, argv[++i]);
    else if (a === "--retry-after") out.retryAfter = number(a, argv[++i]);
    else if (a === "--fail-first") out.failFirst = number(a, argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const collector = createCollector(options);
  const server = createServer(collector.handler);
  server.listen(options.port, () => console.log(`fake collector on :${options.port}${options.out ? `, writing to ${options.out}` : ""} (GET /__report, Ctrl-C for the verdict)`));
  process.on("SIGINT", () => {
    const r = collector.report();
    console.log(`\n${formatReport(r)}`);
    server.close();
    process.exit(r.verdict === "fail" ? 1 : 0);
  });
}
