// node --test scripts/fake-collector.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { CHUNK_MUST, createCollector, decodeLogsRequest, decodeSpanNames, decodeVideoBody, formatReport, mp4Boxes } from "./fake-collector.mjs";

// The cross-platform golden `ouo.replay.chunk` request: the bytes sdk/ios writes
// (sdk/ios/Tests/OuoReplayCoreTests/ReplayEnvelopeTests.swift, `goldenHex`) and sdk/android must match.
const GOLDEN_HEX =
  "0ace050a1a0a180a0c736572766963652e6e616d6512080a06676f6c64656e12af050a130a0a6f756f2e7265706c61791205312e302e3012db040900002a36fe9c971710092a083a06676f6c64656e32300a0a73657373696f6e2e696412220a20303030313032303330343035303630373038303930613062306330643065306632330a0d6f756f2e7265706c61792e696412220a203130313131323133313431353136313731383139316131623163316431653166323a0a146f756f2e7265706c61792e73747265616d2e696412220a203230323132323233323432353236323732383239326132623263326432653266321e0a186f756f2e7265706c61792e7365676d656e742e696e6465781202180032190a136f756f2e7265706c61792e73657175656e63651202180032190a136f756f2e7265706c61792e6b65796672616d651202100132200a156f756f2e7265706c61792e73746172745f74696d6512071880d095ffbc31321e0a136f756f2e7265706c61792e656e645f74696d6512071888f795ffbc3132230a116f756f2e7265706c61792e666f726d6174120e0a0c6f756f2d6672616d65732f33321d0a136f756f2e7265706c61792e656e636f64696e6712060a04677a697032570a116f756f2e7265706c61792e73686132353612420a4064643536646534313337393531643963393236383162303334313665633135663838366234343832613237653361353137643332663038353234346362653564321a0a146f756f2e7265706c61792e627974655f73697a651202180632170a116f756f2e7265706c61792e6d61736b656412021001321c0a0f6f756f2e7265706c61792e6d6f646512090a0773657373696f6e5900002a36fe9c971762106f756f2e7265706c61792e6368756e6b1a3a68747470733a2f2f6f70656e74656c656d657472792e696f2f736368656d61732f636c69656e742d736964652d6465762f302e312e302d646576";

// ---- a minimal protobuf writer, to build requests the collector must judge ----
const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  do {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v ? b | 0x80 : b);
  } while (v);
  return Buffer.from(out);
};
const len = (field, payload) => Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
const str = (field, s) => len(field, Buffer.from(s, "utf8"));
const fixed64 = (field, n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return Buffer.concat([varint((field << 3) | 1), b]);
};
const any = (v) => (typeof v === "string" ? str(1, v) : typeof v === "boolean" ? Buffer.concat([varint((2 << 3) | 0), varint(v ? 1 : 0)]) : Buffer.isBuffer(v) ? len(7, v) : Buffer.concat([varint((3 << 3) | 0), varint(v)]));
const kv = (field, key, value) => len(field, Buffer.concat([str(1, key), len(2, any(value))]));
function request(scopeName, records) {
  const scope = len(1, Buffer.concat([str(1, scopeName), str(2, "1.0.0")]));
  const logRecords = records.map((r) =>
    len(2, Buffer.concat([fixed64(1, 1n), ...(r.body ? [len(5, any(r.body))] : []), ...Object.entries(r.attributes).map(([k, v]) => kv(6, k, v)), fixed64(11, 1n), str(12, r.event)])),
  );
  const resource = len(1, kv(1, "service.name", "test"));
  return len(1, Buffer.concat([resource, len(2, Buffer.concat([scope, ...logRecords]))]));
}
const ndjson = (events) => gzipSync(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
function chunk(stream, sequence, overrides = {}, events = [{ t: 1, type: sequence === 0 ? "frame" : "patch" }]) {
  const body = overrides.body ?? ndjson(events);
  const attributes = {
    "session.id": "s".repeat(32),
    "ouo.replay.id": "r".repeat(32),
    "ouo.replay.stream.id": stream,
    "ouo.replay.segment.index": 0,
    "ouo.replay.sequence": sequence,
    "ouo.replay.keyframe": sequence === 0,
    "ouo.replay.start_time": 1700000000000,
    "ouo.replay.end_time": 1700000005000,
    "ouo.replay.format": "ouo-frames/3",
    "ouo.replay.encoding": "gzip",
    "ouo.replay.sha256": createHash("sha256").update(body).digest("hex"),
    "ouo.replay.byte_size": body.length,
    "ouo.replay.masked": true,
    "ouo.replay.mode": "session",
    ...overrides.attributes,
  };
  for (const key of overrides.remove ?? []) delete attributes[key];
  return { event: "ouo.replay.chunk", body, attributes };
}
const ended = (stream, lastSequence, more = {}) => ({
  event: "ouo.replay.ended",
  attributes: { "session.id": "s".repeat(32), "ouo.replay.id": "r".repeat(32), "ouo.replay.stream.id": stream, "ouo.replay.end_state": "complete", "ouo.replay.last_sequence": lastSequence, "ouo.replay.end_reason": "session_end", ...more },
});
const PROTO = { "content-type": "application/x-protobuf" };
const send = (c, record, headers = PROTO) => c.accept("/v1/logs", headers, request("ouo.replay", [record]));

test("decodes the golden ouo.replay.chunk request of sdk/ios", () => {
  const [record, ...rest] = decodeLogsRequest(Buffer.from(GOLDEN_HEX, "hex"));
  assert.equal(rest.length, 0);
  assert.deepEqual(record.resource, { "service.name": { type: "string", value: "golden" } });
  assert.deepEqual(record.scope, { name: "ouo.replay", version: "1.0.0" });
  assert.equal(record.eventName, "ouo.replay.chunk");
  assert.equal(record.schemaUrl, "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev");
  assert.deepEqual(record.body, { type: "bytes", value: Buffer.from("golden") });
  assert.equal(record.timeUnixNano, 1700000000000n * 1000000n);
  const a = record.attributes;
  // Every MUST attribute of spec 11.3, with its type.
  for (const [key, type] of Object.entries(CHUNK_MUST)) assert.equal(a[key]?.type, type, key);
  assert.equal(a["session.id"].value, "000102030405060708090a0b0c0d0e0f");
  assert.equal(a["ouo.replay.id"].value, "101112131415161718191a1b1c1d1e1f");
  assert.equal(a["ouo.replay.stream.id"].value, "202122232425262728292a2b2c2d2e2f");
  assert.equal(a["ouo.replay.sequence"].value, 0);
  assert.equal(a["ouo.replay.segment.index"].value, 0);
  assert.equal(a["ouo.replay.keyframe"].value, true);
  assert.equal(a["ouo.replay.start_time"].value, 1700000000000);
  assert.equal(a["ouo.replay.end_time"].value, 1700000005000);
  assert.equal(a["ouo.replay.format"].value, "ouo-frames/3");
  assert.equal(a["ouo.replay.encoding"].value, "gzip");
  assert.equal(a["ouo.replay.byte_size"].value, 6);
  assert.equal(a["ouo.replay.sha256"].value, createHash("sha256").update("golden").digest("hex"));
  assert.equal(a["ouo.replay.masked"].value, true);
  assert.equal(a["ouo.replay.mode"].value, "session");
});

test("the golden request passes the envelope rules; its 6-byte body is not a gzip stream", () => {
  const c = createCollector();
  c.accept("/v1/logs", PROTO, Buffer.from(GOLDEN_HEX, "hex"));
  const r = c.report();
  for (const rule of ["one_chunk_per_request", "no_content_encoding", "chunk_attributes", "body_size", "hash_and_size"]) assert.equal(r.rules[rule].result, "pass", rule);
  assert.equal(r.rules.body_decodes.result, "fail");
});

test("a well-formed stream passes every rule", () => {
  const c = createCollector();
  send(c, chunk("a", 0, {}, [{ t: 1, type: "frame", w: 10, h: 10 }, { t: 2, type: "touch" }]));
  send(c, chunk("a", 2));
  send(c, chunk("a", 1)); // arrival order is not sequence order
  send(c, chunk("a", 1)); // a retry: at-least-once
  send(c, chunk("a", 3, { attributes: { "ouo.replay.segment.index": 1, "ouo.replay.keyframe": true } }, [{ t: 9, type: "frame" }]));
  send(c, ended("a", 3));
  // A buffered stream with its trigger, still open.
  send(c, chunk("b", 0, { attributes: { "ouo.replay.mode": "buffer", "ouo.replay.trigger": "error" } }));
  const r = c.report();
  assert.equal(r.verdict, "pass", formatReport(r));
  for (const [name, rule] of Object.entries(r.rules)) assert.equal(rule.result, "pass", name);
  assert.deepEqual(r.openStreams, ["b"]);
  assert.equal(r.streams.find((s) => s.stream === "a").duplicates, 1);
  assert.equal(r.streams.find((s) => s.stream === "a").highestSequence, 3);
  assert.match(formatReport(r), /verdict: PASS/);
});

test("each rule fails on the request that breaks it", () => {
  const cases = {
    chunk_attributes: (c) => send(c, chunk("a", 0, { remove: ["ouo.replay.masked"] })),
    "chunk_attributes (type)": (c) => send(c, chunk("a", 0, { attributes: { "ouo.replay.sequence": "0" } })),
    "chunk_attributes (ref)": (c) => send(c, chunk("a", 0, { attributes: { "ouo.replay.ref": "s3://x" } })),
    "chunk_attributes (trigger)": (c) => send(c, chunk("a", 0, { attributes: { "ouo.replay.mode": "buffer" } })),
    no_content_encoding: (c) => c.accept("/v1/logs", { ...PROTO, "content-encoding": "gzip" }, gzipSync(request("ouo.replay", [chunk("a", 0)]))),
    one_chunk_per_request: (c) => c.accept("/v1/logs", PROTO, request("ouo.replay", [chunk("a", 0), chunk("a", 1)])),
    body_size: (c) => send(c, chunk("a", 0, { body: Buffer.alloc(1024 * 1024 + 1) })),
    hash_and_size: (c) => send(c, chunk("a", 0, { attributes: { "ouo.replay.sha256": "0".repeat(64) } })),
    "hash_and_size (size)": (c) => send(c, chunk("a", 0, { attributes: { "ouo.replay.byte_size": 1 } })),
    body_decodes: (c) => send(c, chunk("a", 0, { body: Buffer.from("not gzip") })),
    "body_decodes (line)": (c) => send(c, chunk("a", 0, {}, [{ t: 1, type: "frame" }, { type: "no t" }])),
    sequence: (c) => [0, 1, 3].forEach((n) => send(c, chunk("a", n))),
    "sequence (not from 0)": (c) => send(c, chunk("a", 1, { attributes: { "ouo.replay.keyframe": true } }, [{ t: 1, type: "frame" }])),
    keyframe: (c) => send(c, chunk("a", 0, { attributes: { "ouo.replay.keyframe": false } })),
    "keyframe (first event)": (c) => send(c, chunk("a", 0, {}, [{ t: 1, type: "patch" }])),
    ended: (c) => [chunk("a", 0), chunk("a", 1), ended("a", 0)].forEach((r) => send(c, r)),
    "ended (twice)": (c) => [chunk("a", 0), ended("a", 0), ended("a", 0)].forEach((r) => send(c, r)),
    "ended (reason)": (c) => [chunk("a", 0), ended("a", 0, { "ouo.replay.end_reason": "because" })].forEach((r) => send(c, r)),
  };
  for (const [name, run] of Object.entries(cases)) {
    const c = createCollector();
    run(c);
    const r = c.report();
    const rule = name.split(" ")[0];
    assert.equal(r.rules[rule].result, "fail", `${name}: ${formatReport(r)}`);
    assert.equal(r.verdict, "fail", name);
  }
});

// ---- ouo-video/1: a header line, then an mp4 (boxes ftyp, moov, mdat) ----
const box = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
};
const MP4 = Buffer.concat([box("ftyp", Buffer.from("mp42\0\0\0\0mp42isom")), box("moov", Buffer.alloc(16)), box("mdat", Buffer.alloc(32, 7))]);
const videoBody = (header = {}, mp4 = MP4) =>
  Buffer.concat([Buffer.from(JSON.stringify({ t: 1, type: "video", end: 5001, w: 402, h: 874, scale: 1, fps: 1, frames: 5, mp4: mp4.length, touches: [{ t: 2, x: 1.5, y: 2, phase: "began" }], ...header }) + "\n"), mp4]);
const videoChunk = (stream, sequence, body = videoBody(), attributes = {}) =>
  chunk(stream, sequence, { body, attributes: { "ouo.replay.format": "ouo-video/1", "ouo.replay.encoding": "identity", "ouo.replay.keyframe": true, "ouo.replay.segment.index": sequence, ...attributes } });

test("ouo-video/1: every chunk a segment with a header line and an mp4 passes every rule", () => {
  assert.deepEqual(mp4Boxes(MP4).boxes, ["ftyp", "moov", "mdat"]);
  assert.equal(decodeVideoBody(videoBody()).mp4.length, MP4.length);
  const c = createCollector();
  [0, 1, 2].forEach((n) => send(c, videoChunk("v", n)));
  send(c, ended("v", 2));
  const r = c.report();
  assert.equal(r.verdict, "pass", formatReport(r));
  for (const [name, rule] of Object.entries(r.rules)) assert.equal(rule.result, "pass", name);
});

test("ouo-video/1: each broken body fails body_decodes", () => {
  const cases = {
    gzip: videoChunk("v", 0, videoBody(), { "ouo.replay.encoding": "gzip" }),
    "no header line": videoChunk("v", 0, MP4),
    "wrong length": videoChunk("v", 0, videoBody({ mp4: 3 })),
    "not video": videoChunk("v", 0, videoBody({ type: "frame" })),
    "bad touches": videoChunk("v", 0, videoBody({ touches: [{ t: 1 }] })),
    "not an mp4": videoChunk("v", 0, videoBody({}, Buffer.from("0000moovxxxxxxxxxxxx"))),
    "truncated mp4": videoChunk("v", 0, videoBody({}, MP4.subarray(0, MP4.length - 3))),
    "no mdat": videoChunk("v", 0, videoBody({}, Buffer.concat([box("ftyp", Buffer.alloc(8)), box("moov")]))),
  };
  for (const [name, record] of Object.entries(cases)) {
    const c = createCollector();
    send(c, record);
    assert.equal(c.report().rules.body_decodes.result, "fail", name);
  }
});

test("telemetry: JSON and protobuf, gzip or not; event and span names are recorded", () => {
  const c = createCollector();
  const logs = { resourceLogs: [{ scopeLogs: [{ scope: { name: "@ouo11y/react-native" }, logRecords: [{ eventName: "session.start", attributes: [] }, { attributes: [{ key: "event.name", value: { stringValue: "navigation" } }] }] }] }] };
  c.accept("/v1/logs", { "content-type": "application/json" }, Buffer.from(JSON.stringify(logs)));
  c.accept("/v1/logs", { "content-type": "application/json", "content-encoding": "gzip" }, gzipSync(Buffer.from(JSON.stringify(logs))));
  c.accept("/v1/logs", PROTO, request("ouo.rum", [{ event: "exception", attributes: { "session.id": "x" } }]));
  c.accept("/v1/traces", { "content-type": "application/json" }, Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: "HTTP GET" }] }] }] })));
  // ExportTraceServiceRequest > ResourceSpans(1) > ScopeSpans(2) > Span(2) > name(5)
  const traces = len(1, len(2, len(2, str(5, "HTTP POST"))));
  c.accept("/v1/traces", PROTO, traces);
  assert.deepEqual(decodeSpanNames(traces), ["HTTP POST"]);
  const r = c.report();
  assert.deepEqual(r.telemetry.events, { "session.start": 2, navigation: 2, exception: 1 });
  assert.deepEqual(r.telemetry.spans, { "HTTP GET": 1, "HTTP POST": 1 });
  assert.equal(r.verdict, "nothing_to_check");
});

test("over HTTP: fault injection, then 200; /__report", async () => {
  const { createServer } = await import("node:http");
  const c = createCollector({ failFirst: 2, status: 503, retryAfter: 1 });
  const server = createServer(c.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = () => fetch(`${base}/v1/logs`, { method: "POST", headers: PROTO, body: request("ouo.replay", [chunk("a", 0)]) });
    for (let i = 0; i < 2; i++) {
      const res = await post();
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "1");
    }
    const ok = await post();
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "{}");
    assert.equal((await fetch(`${base}/v1/logs`, { method: "POST", headers: PROTO, body: Buffer.from([0xff, 0xff]) })).status, 400);
    assert.equal((await fetch(`${base}/nope`, { method: "POST" })).status, 404);
    const report = await (await fetch(`${base}/__report`)).json();
    assert.equal(report.faultsInjected, 2);
    assert.equal(report.streams[0].chunks, 1);
    assert.equal(report.rules.sequence.result, "pass");
  } finally {
    server.close();
  }
});
