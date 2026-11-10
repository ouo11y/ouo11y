// Local capture server for the Datadog browser SDK (Step 6 vendor research).
//
// - Serves the demo page (public/) and the SDK CDN bundles from node_modules (no CDN).
// - Receives every intake request the SDK sends through its `proxy` option
//   (POST /intake?ddforward=<path+params>) and writes it to captures/ as JSON:
//   headers, query parameters, raw size, and the decoded body (deflate inflated,
//   NDJSON split into events, multipart parts parsed, replay segments decoded).
// - Serves a tiny test backend under /api/* and records the request headers it
//   sees (trace propagation headers).
//
// No dependencies: node:http, node:zlib, node:fs only. Node 24.

import { createServer } from 'node:http'
import { inflateSync, inflateRawSync, gunzipSync, constants as zc } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'

const HERE = import.meta.dirname
const PORT = Number(process.env.PORT ?? 4560)
const HOST = '127.0.0.1'
const OUT = process.env.CAPTURE_DIR ?? join(HERE, 'captures')
mkdirSync(OUT, { recursive: true })

const STATIC_ROOTS = {
  '/vendor/rum/': join(HERE, 'node_modules/@datadog/browser-rum/bundle/'),
  '/vendor/logs/': join(HERE, 'node_modules/@datadog/browser-logs/bundle/'),
  '/': join(HERE, 'public/'),
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' }

let seq = 0
const nextName = (label) => `${String(++seq).padStart(4, '0')}-${label}`

function inflate(buf) {
  // The SDK's deflate worker emits a zlib stream (RFC 1950). Be lenient about the trailer.
  try {
    return inflateSync(buf, { finishFlush: zc.Z_SYNC_FLUSH })
  } catch {
    return inflateRawSync(buf, { finishFlush: zc.Z_SYNC_FLUSH })
  }
}

function parseNdjson(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { _unparsed: l }
      }
    })
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  if (!m) return []
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`)
  const parts = []
  let pos = buf.indexOf(boundary)
  while (pos !== -1) {
    const start = pos + boundary.length
    if (buf.subarray(start, start + 2).toString() === '--') break
    const next = buf.indexOf(boundary, start)
    if (next === -1) break
    const part = buf.subarray(start + 2, next - 2) // strip CRLF after boundary and before next
    const headerEnd = part.indexOf('\r\n\r\n')
    const headerText = part.subarray(0, headerEnd).toString()
    const body = part.subarray(headerEnd + 4)
    const headers = Object.fromEntries(
      headerText.split('\r\n').map((h) => {
        const i = h.indexOf(':')
        return [h.slice(0, i).toLowerCase(), h.slice(i + 1).trim()]
      })
    )
    const disp = headers['content-disposition'] ?? ''
    parts.push({
      name: /name="([^"]*)"/.exec(disp)?.[1],
      filename: /filename="([^"]*)"/.exec(disp)?.[1],
      contentType: headers['content-type'],
      bytes: body.length,
      body,
    })
    pos = next
  }
  return parts
}

function decodeBody(buf, contentType, params, contentEncoding) {
  // Mobile SDKs compress the whole request body and say so in Content-Encoding (deflate on iOS, gzip on Android).
  if (contentEncoding === 'gzip') buf = gunzipSync(buf)
  else if (contentEncoding === 'deflate') buf = inflate(buf)
  if (contentType?.startsWith('multipart/form-data')) {
    const parts = parseMultipart(buf, contentType).map((p) => {
      const out = { name: p.name, filename: p.filename, contentType: p.contentType, bytes: p.bytes }
      if (p.name === 'event' || p.contentType === 'application/json') {
        out.json = JSON.parse(p.body.toString())
      } else if (p.name === 'segment') {
        const raw = inflate(p.body)
        out.inflatedBytes = raw.length
        // A segment is one JSON object terminated by "\n": {"records":[...], ...metadata}
        out.json = JSON.parse(raw.toString())
      } else {
        out.sha256 = createHash('sha256').update(p.body).digest('hex')
        out.head = p.body.subarray(0, 16).toString('hex')
      }
      return out
    })
    return { kind: 'multipart', parts }
  }
  const encoding = params.get('dd-evp-encoding')
  const raw = encoding === 'deflate' ? inflate(buf) : buf
  const text = raw.toString()
  // iOS and Android send a JSON array for some tracks; the browser sends NDJSON.
  if (text.trimStart().startsWith('[')) {
    try {
      return { kind: 'json-array', encoding: encoding ?? contentEncoding ?? 'identity', inflatedBytes: raw.length, events: JSON.parse(text) }
    } catch {}
  }
  return { kind: 'ndjson', encoding: encoding ?? contentEncoding ?? 'identity', inflatedBytes: raw.length, events: parseNdjson(text) }
}

function labelFor(track, decoded) {
  if (decoded.kind === 'ndjson' || decoded.kind === 'json-array') {
    const types = [...new Set(decoded.events.map((e) => e.type ?? e.status ?? 'log'))]
    return `${track}-${types.join('+').slice(0, 60)}`
  }
  if (decoded.kind !== 'multipart') return `${track}-undecoded`
  const seg = decoded.parts.find((p) => p.name === 'segment')
  if (seg) return `${track}-segment-${seg.json.index_in_view === 0 ? 'first' : 'next'}`
  return `${track}-${decoded.parts.map((p) => p.name).join('+')}`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function handleIntake(req, res, url) {
  const buf = await readBody(req)
  // Browser: POST /intake?ddforward=<path+params> (the `proxy` option).
  // Mobile: POST /api/v2/<track>?... (the `customEndpoint` options point straight here).
  const forward = url.pathname === '/intake' ? (url.searchParams.get('ddforward') ?? '') : url.pathname + url.search
  const fwd = new URL(forward, 'https://intake.invalid')
  const track = fwd.pathname.replace('/api/v2/', '').replace(/^\//, '').replace(/\//g, '_') || 'unknown'
  let decoded
  try {
    decoded = decodeBody(buf, req.headers['content-type'], fwd.searchParams, req.headers['content-encoding'])
  } catch (e) {
    decoded = { kind: 'error', message: String(e) }
  }
  const name = nextName(labelFor(track, decoded))
  const record = {
    receivedAt: new Date().toISOString(),
    method: req.method,
    proxyUrl: req.url,
    forwardPath: fwd.pathname,
    forwardParams: Object.fromEntries(fwd.searchParams),
    headers: req.headers,
    bodyBytes: buf.length,
    body: decoded,
  }
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(record, null, 2))
  writeFileSync(join(OUT, `${name}.bin`), buf)
  console.log(`${name}  ${buf.length} B  ${req.headers['content-type'] ?? ''}`)
  // Datadog's intake answers 202 Accepted.
  res.writeHead(202, { 'content-type': 'application/json' }).end('{}')
}

function handleApi(req, res, url) {
  const name = nextName(`backend${url.pathname.replace(/\//g, '-')}`)
  writeFileSync(
    join(OUT, `${name}.json`),
    JSON.stringify({ receivedAt: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers }, null, 2)
  )
  const status = url.pathname.endsWith('/fail') ? 500 : 200
  const delay = url.pathname.endsWith('/slow') ? 800 : 20
  setTimeout(() => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: status === 200, path: url.pathname }))
  }, delay)
}

function handleStatic(req, res, url) {
  for (const [prefix, root] of Object.entries(STATIC_ROOTS)) {
    if (!url.pathname.startsWith(prefix)) continue
    const rel = url.pathname.slice(prefix.length) || 'index.html'
    const file = normalize(join(root, rel))
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) continue
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(file))
    return
  }
  res.writeHead(404).end('not found')
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'POST' && (url.pathname === '/intake' || url.pathname.startsWith('/api/v2/'))) {
    handleIntake(req, res, url).catch((e) => res.writeHead(500).end(String(e)))
    return
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url)
  return handleStatic(req, res, url)
})

server.listen(PORT, HOST, () => console.log(`datadog-capture listening on http://${HOST}:${PORT}  (captures -> ${OUT})`))
