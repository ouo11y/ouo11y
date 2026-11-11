// Drives the demo page in headless Chrome over the DevTools protocol, with trusted
// (isTrusted) mouse and keyboard input, then leaves the page so the SDK flushes on exit.
// No dependencies: Node 24 has a global WebSocket and fetch.
//
//   node drive.mjs                 # default scenario
//   node drive.mjs "compress=1&viewUpdates=1"
//
// Env: CHROME (path to the Chrome binary), PAGE_PORT (default 4560), CDP_PORT (default 4561).

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PAGE_PORT = Number(process.env.PAGE_PORT ?? 4560)
const CDP_PORT = Number(process.env.CDP_PORT ?? 4561)
const query = process.argv[2] ?? ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'dd-capture-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' }
)
console.log(`chrome pid ${chrome.pid}`)

let ws
let id = 0
const pending = new Map()
function send(method, params = {}) {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }))
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(200)
  }
  throw new Error('Chrome DevTools endpoint not reachable')
}

async function center(selector) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}) })()`,
    returnByValue: true,
  })
  return JSON.parse(result.value)
}

async function click(selector, times = 1, gap = 120) {
  const { x, y } = await center(selector)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (let i = 0; i < times; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(gap)
  }
  console.log(`clicked ${selector} x${times}`)
}

async function typeText(selector, text) {
  await click(selector)
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(30)
  }
  console.log(`typed into ${selector}`)
}

try {
  ws = new WebSocket(await connect())
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  await send('Page.enable')
  await send('Runtime.enable')
  const url = `http://127.0.0.1:${PAGE_PORT}/?run=${Date.now()}${query ? `&${query}` : ''}`
  await send('Page.navigate', { url })
  console.log(`navigated to ${url}`)
  await sleep(2500)

  await click('#btn-action')
  await click('#btn-plain')
  await sleep(300)
  await click('#btn-dead')
  await sleep(1200)
  await click('#btn-dead', 4, 80) // rage click: >= 3 clicks within 1 s
  await sleep(1200)
  await click('#btn-custom')
  await click('#btn-fetch-ok')
  await click('#btn-fetch-fail')
  await click('#btn-xhr-slow')
  await sleep(1200)
  await click('#btn-throw')
  await click('#btn-reject')
  await click('#btn-console')
  await click('#btn-adderror')
  await click('#btn-log')
  await click('#btn-longtask')
  await typeText('#name', 'Jane Secret')
  await typeText('#pw', 'hunter2')
  await click('#btn-mutate')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 400 })
  await sleep(1500)
  await click('#btn-nav')
  await sleep(6000) // let a replay segment flush on its 5 s timer
  await click('#btn-plain')
  await sleep(1000)
  // Leave the page: triggers pagehide / visibilitychange → flush via sendBeacon.
  await send('Page.navigate', { url: 'about:blank' })
  console.log('left the page')
  await sleep(3000)
} finally {
  try {
    ws?.close()
  } catch {}
  chrome.kill('SIGTERM')
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
  console.log('done')
}
