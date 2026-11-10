// Local stand-in for a PostHog ingestion host, for Step 6 vendor research.
// It serves the demo page and the posthog-js dist files, mocks the remote
// config and /flags responses, and saves every request it receives, decoded.
// No dependencies: node:http, node:zlib, node:fs only.
//
//   node server.mjs            # listens on 127.0.0.1:4570
//   PORT=4571 node server.mjs
//
// Open http://posthog-capture.localhost:4570/ (a *.localhost name resolves to
// 127.0.0.1 in Chrome, and posthog-js turns off replay network capture only for
// the exact hostnames "localhost" and "127.0.0.1").

import http from 'node:http'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 4570)
const OUT = process.env.OUT || path.join(HERE, 'captures')
const DIST = path.join(HERE, 'node_modules', 'posthog-js', 'dist')
// Behaviour switches for reliability experiments, set by query on /__ctl
const ctl = { failStatus: 0, failCount: 0, quotaLimited: false }

fs.mkdirSync(OUT, { recursive: true })
let seq = 0

// The remote config posthog-js fetches from GET /array/<token>/config (JSON).
// Keys follow posthog/models/remote_config.py build_config() at the pinned
// PostHog commit; values here switch on every RUM-relevant feature.
const remoteConfig = (token) => ({
  token,
  supportedCompression: ['gzip', 'gzip-js'],
  hasFeatureFlags: true,
  captureDeadClicks: true,
  capturePerformance: { network_timing: true, web_vitals: true, web_vitals_allowed_metrics: null },
  autocapture_opt_out: false,
  autocaptureExceptions: true,
  analytics: { endpoint: '/i/v0/e/' },
  elementsChainAsString: true,
  errorTracking: { autocaptureExceptions: true, suppressionRules: [] },
  logs: { captureConsoleLogs: true },
  heatmaps: true,
  surveys: false,
  productTours: false,
  defaultIdentifiedOnly: true,
  siteApps: [],
  sessionRecording: ctl.quotaLimited
    ? false
    : {
        endpoint: '/s/',
        consoleLogRecordingEnabled: true,
        recorderVersion: 'v2',
        sampleRate: null,
        minimumDurationMilliseconds: null,
        linkedFlag: null,
        networkPayloadCapture: { recordHeaders: true, recordBody: true },
        masking: null,
        urlTriggers: [],
        urlBlocklist: [],
        eventTriggers: [],
        triggerMatchType: null,
        scriptConfig: null,
        recordCanvas: false,
        version: 1,
      },
  ...(ctl.quotaLimited ? { quotaLimited: ['recordings'] } : {}),
})

const flagsResponse = () => ({
  flags: {
    'demo-flag': {
      key: 'demo-flag',
      enabled: true,
      variant: null,
      reason: { code: 'condition_match', condition_index: 0, description: 'Matched condition set 1' },
      metadata: { id: 1, version: 1, payload: null },
    },
  },
  errorsWhileComputingFlags: false,
  requestId: '00000000-0000-0000-0000-000000000000',
  quotaLimited: ctl.quotaLimited ? ['recordings'] : [],
})

// rrweb events compressed by posthog-js carry cv: '2024-10'. Their gzipped
// fields are binary strings (fflate strFromU8(..., latin1=true)).
function gunzipLatin1(s) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(s, 'latin1')).toString('utf8'))
}
function decodeRrwebEvent(e) {
  if (!e || e.cv !== '2024-10') return e
  const out = { ...e, _decodedFrom: 'cv 2024-10' }
  try {
    if (e.type === 2 && typeof e.data === 'string') out.data = gunzipLatin1(e.data)
    if (e.type === 3 && e.data) {
      out.data = { ...e.data }
      for (const k of ['texts', 'attributes', 'removes', 'adds']) {
        if (typeof e.data[k] === 'string') out.data[k] = gunzipLatin1(e.data[k])
      }
    }
  } catch (err) {
    out._decodeError = String(err)
  }
  return out
}
function decodeSnapshots(events) {
  if (!Array.isArray(events)) return events
  return events.map((ev) => {
    if (ev?.event !== '$snapshot') return ev
    const p = ev.properties || {}
    const data = Array.isArray(p.$snapshot_data) ? p.$snapshot_data.map(decodeRrwebEvent) : p.$snapshot_data
    return { ...ev, properties: { ...p, $snapshot_data: data } }
  })
}

// Mirrors rust/capture compression handling: query `compression`, then form
// field, then Content-Encoding; gzip is also sniffed by magic bytes.
function decodeBody(buf, query, headers) {
  const info = { rawBytes: buf.length, contentType: headers['content-type'] || '', steps: [] }
  let compression = query.get('compression') || ''
  let body = buf
  if (info.contentType.startsWith('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(buf.toString('utf8'))
    compression = compression || form.get('compression') || ''
    body = Buffer.from(form.get('data') || '', 'utf8')
    info.steps.push('form data=')
  }
  if (!compression && headers['content-encoding']) compression = headers['content-encoding']
  if (body[0] === 0x1f && body[1] === 0x8b) {
    body = zlib.gunzipSync(body)
    info.steps.push('gunzip')
  } else if (compression === 'base64' || compression === 'b64') {
    body = Buffer.from(body.toString('utf8').replace(/ /g, '+'), 'base64')
    info.steps.push('base64')
  } else if (compression === 'lz64' || compression === 'lz-string') {
    info.steps.push('lz64 not decoded (posthog-js 1.447.6 never sends it)')
  }
  const text = body.toString('utf8')
  info.decodedBytes = Buffer.byteLength(text)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { info, json, text: json ? undefined : text.slice(0, 2000) }
}

function save(record) {
  const name = `${String(++seq).padStart(4, '0')}-${record.method}-${record.path.replace(/[^a-z0-9]+/gi, '_')}.json`
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(record, null, 2))
  return name
}

function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': res.req.headers.origin || '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': '*',
  })
  res.end(payload)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const buf = Buffer.concat(chunks)
    if (req.method === 'OPTIONS') return send(res, 204, '')

    // Static: demo page and posthog-js dist (stands in for the asset host)
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html')), 'text/html')
    }
    if (req.method === 'GET' && (p.startsWith('/dist/') || p.startsWith('/static/'))) {
      // /static/<kind>.js?v=<version> is how posthog-js lazy-loads extensions
      const file = path.join(DIST, path.basename(p))
      if (fs.existsSync(file)) {
        if (p.startsWith('/static/')) {
          save({ ts: new Date().toISOString(), method: req.method, path: p, query: Object.fromEntries(url.searchParams), note: 'lazy-loaded extension', bytes: fs.statSync(file).size })
          console.log(`GET ${p}${url.search} (lazy extension)`)
        }
        return send(res, 200, fs.readFileSync(file), 'application/javascript')
      }
      return send(res, 404, 'not found', 'text/plain')
    }
    if (p === '/__ctl') {
      for (const k of Object.keys(ctl)) if (url.searchParams.has(k)) ctl[k] = JSON.parse(url.searchParams.get(k))
      return send(res, 200, ctl)
    }
    if (p === '/api/demo') return send(res, 200, { ok: true, at: Date.now() })
    if (p === '/api/demo-fail') return send(res, 500, { ok: false })

    const record = {
      ts: new Date().toISOString(),
      method: req.method,
      path: p,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers, cookie: req.headers.cookie ? '<redacted>' : undefined },
    }

    // Remote config: JS variant 404s on purpose so the SDK falls back to JSON
    if (/^\/array\/[^/]+\/config\.js$/.test(p)) {
      save({ ...record, note: 'remote config JS (404 on purpose; the SDK then GETs the JSON)' })
      console.log(`GET ${p} -> 404 (on purpose)`)
      return send(res, 404, '', 'application/javascript')
    }
    if (/^\/array\/[^/]+\/config$/.test(p)) {
      const reply = remoteConfig(p.split('/')[2])
      save({ ...record, response: reply })
      console.log(`GET ${p} -> 200 remote config`)
      return send(res, 200, reply)
    }

    if (buf.length) {
      // RAW=1 keeps the undecoded wire bytes too (base64), to show the on-wire shape
      if (process.env.RAW) record.rawBodyBase64 = buf.toString('base64')
      try {
        const d = decodeBody(buf, url.searchParams, req.headers)
        record.decode = d.info
        if (process.env.RAW && d.json !== undefined) record.decodedBodyBeforeSnapshotDecode = d.json
        if (d.json !== undefined) {
          const events = Array.isArray(d.json) ? d.json : d.json.batch
          record.body = events ? decodeSnapshots(events) : d.json
          if (!Array.isArray(d.json) && d.json.batch) record.bodyEnvelope = { ...d.json, batch: `<${d.json.batch.length} events, see body>` }
        } else {
          record.body = d.text
        }
      } catch (err) {
        record.decodeError = String(err)
      }
    }

    let status = 200
    let reply = { status: 'Ok' }
    if (p.startsWith('/flags')) {
      reply = flagsResponse()
    } else if (ctl.failCount > 0 && ctl.failStatus) {
      ctl.failCount--
      status = ctl.failStatus
      reply = { type: 'experiment', detail: `forced ${status}` }
    } else if (p.startsWith('/s') && ctl.quotaLimited) {
      reply = { status: 'Ok', quota_limited: ['recordings'] }
    } else if (url.searchParams.get('beacon') === '1') {
      status = 204
      reply = ''
    }
    record.response = { status, body: reply }
    const name = save(record)
    console.log(`${req.method} ${p}${url.search} -> ${status} ${name} ${record.decode ? JSON.stringify(record.decode) : ''}`)
    send(res, status, reply)
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`posthog-capture on http://posthog-capture.localhost:${PORT}/ pid=${process.pid}`))
