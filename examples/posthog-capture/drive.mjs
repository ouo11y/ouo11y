// Drives the demo page in headless Chrome over the DevTools protocol, with real
// input events (so autocapture, rage clicks and replay see them), then
// navigates away to trigger the unload flush (sendBeacon).
// No dependencies: Node 24 has a global WebSocket.
//
//   node drive.mjs            # expects server.mjs on 4570, uses CDP port 4579
//
// Env: CHROME (path), PORT (server port), CDP_PORT, OFFLINE_TEST=1 (adds an
// offline/online cycle), STAY_MS (time on page after the script, default 8000).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.PORT || 4570)
const CDP_PORT = Number(process.env.CDP_PORT || 4579)
const ORIGIN = `http://posthog-capture.localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-capture-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore' })
console.log(`chrome pid=${chrome.pid}`)

let ws
let id = 0
const pending = new Map()
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(200)
  }
  throw new Error('no CDP target')
}

async function center(selector) {
  const { result } = await cdp('Runtime.evaluate', {
    expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}) })()`,
    returnByValue: true,
  })
  return JSON.parse(result.value)
}
async function click(selector, times = 1, gap = 120) {
  const { x, y } = await center(selector)
  for (let i = 0; i < times; i++) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(gap)
  }
}
async function type(selector, text) {
  await click(selector)
  for (const ch of text) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
  }
}

try {
  ws = new WebSocket(await connect())
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    } else if (msg.method === 'Network.requestWillBeSent' && process.env.NETLOG && !/\/(dist|static)\//.test(msg.params.request.url)) {
      const u = new URL(msg.params.request.url)
      console.log(new Date().toISOString(), 'net:', msg.params.type, msg.params.request.method, u.pathname + u.search)
    } else if (msg.method === 'Network.loadingFailed' && process.env.NETLOG) {
      console.log(new Date().toISOString(), 'net failed:', msg.params.type, msg.params.errorText)
    } else if (msg.method === 'Runtime.consoleAPICalled' && process.env.VERBOSE) {
      console.log('console:', msg.params.type, msg.params.args.map((a) => a.value).join(' '))
    }
  })
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Network.enable')
  // posthog-js drops events from bot user agents, and "HeadlessChrome" is on its
  // list (opt_out_useragent_filter). Present a normal desktop Chrome UA instead.
  const { userAgent } = await cdp('Browser.getVersion')
  await cdp('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') })
  await cdp('Page.navigate', { url: `${ORIGIN}/` })
  await sleep(4000) // config, flags, recorder load, first full snapshot

  await click('#btn-click')
  await sleep(500)
  await click('#btn-rage', 4, 100)
  await click('#dead')
  await type('#name', 'Alice')
  await type('#password', 'hunter2')
  await type('#captured', 'visible-value')
  await click('#submit')
  await click('#btn-fetch')
  await click('#btn-fetch-fail')
  await click('#btn-console')
  await click('#btn-throw')
  await click('#btn-reject')
  await click('#btn-manual')
  await click('#btn-mutate')
  await sleep(1500)
  await click('#btn-nav')
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 400, deltaX: 0, deltaY: 600 })

  if (process.env.OFFLINE_TEST) {
    await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await click('#btn-click')
    await sleep(5000)
    await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  }

  await sleep(Number(process.env.STAY_MS || 8000))
  // Leave the page: pagehide/visibilitychange flush via sendBeacon
  console.log(new Date().toISOString(), 'leaving page')
  if (process.env.VERBOSE) {
    // log every beacon and every event the SDK hands to before_send during unload
    await cdp('Runtime.evaluate', { expression: `(() => {
      const ob = navigator.sendBeacon.bind(navigator)
      navigator.sendBeacon = (u, b) => { const ok = ob(u, b); console.log('beacon', u, b && b.size, ok); return ok }
      addEventListener('pagehide', () => console.log('pagehide fired'))
      posthog.set_config({ before_send: (e) => { console.log('event', e && e.event); return e } })
    })()` })
  }
  await click('#btn-click')
  await cdp('Page.navigate', { url: 'about:blank' })
  await sleep(2000)
} catch (err) {
  console.error('drive failed:', err)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  process.kill(chrome.pid) // only the PID this script started
  await sleep(1000)
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
