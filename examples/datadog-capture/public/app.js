// Demo page script. Fake ids only: the capture server never forwards anything to Datadog.
// Query parameters: ?compress=1 (compressIntakeRequests), ?viewUpdates=1 (betaEnableViewUpdates),
// ?replay=0 (sessionReplaySampleRate 0), ?privacy=<level> (defaultPrivacyLevel).
const q = new URLSearchParams(location.search)
const FAKE_APP_ID = '00000000-0000-4000-8000-000000000000'
const FAKE_CLIENT_TOKEN = 'pub00000000000000000000000000000000'
const PROXY = `${location.origin}/intake`

const common = {
  clientToken: FAKE_CLIENT_TOKEN,
  site: 'datadoghq.eu',
  service: 'datadog-capture',
  env: 'local',
  version: '0.0.1',
  proxy: PROXY,
  sessionSampleRate: 100,
  telemetrySampleRate: 100, // so SDK telemetry events show up in the capture
}

window.DD_RUM.init({
  ...common,
  applicationId: FAKE_APP_ID,
  sessionReplaySampleRate: q.get('replay') === '0' ? 0 : 100,
  defaultPrivacyLevel: q.get('privacy') ?? 'mask-user-input',
  trackUserInteractions: true,
  trackResources: true,
  trackLongTasks: true,
  compressIntakeRequests: q.get('compress') === '1',
  betaEnableViewUpdates: q.get('viewUpdates') === '1',
  allowedTracingUrls: [{ match: (url) => url.includes('/api/'), propagatorTypes: ['tracecontext', 'datadog'] }],
  traceSampleRate: 100,
  trackResourceHeaders: true,
})
window.DD_RUM.setUser({ id: 'user-123', name: 'Demo User', plan: 'free' })
window.DD_RUM.setGlobalContextProperty('demo.run', q.get('run') ?? 'manual')

window.DD_LOGS.init({ ...common, forwardErrorsToLogs: true, forwardConsoleLogs: ['error', 'warn'] })

const log = (msg) => {
  const el = document.getElementById('log')
  if (el) el.textContent += `${new Date().toISOString().slice(11, 23)} ${msg}\n`
}

const on = (id, fn) => document.getElementById(id).addEventListener('click', fn)

window.addEventListener('DOMContentLoaded', () => {
  on('btn-action', () => log('named click'))
  on('btn-plain', () => {
    document.getElementById('title').textContent = 'Datadog capture demo (clicked)'
    log('plain click')
  })
  on('btn-custom', () => {
    window.DD_RUM.addAction('checkout.started', { cart: { items: 3, total: 42.5 } })
    window.DD_RUM.addTiming('hero_image_loaded')
    window.DD_RUM.startDurationVital('demo.compute', { context: { kind: 'demo' } })
    setTimeout(() => window.DD_RUM.stopDurationVital('demo.compute'), 120)
    window.DD_RUM.addFeatureFlagEvaluation('new-checkout', true)
    log('custom action, timing, duration vital, feature flag')
  })
  on('btn-fetch-ok', () => fetch('/api/ok').then((r) => log(`fetch ok ${r.status}`)))
  on('btn-fetch-fail', () => fetch('/api/fail').then((r) => log(`fetch fail ${r.status}`)))
  on('btn-xhr-slow', () => {
    const x = new XMLHttpRequest()
    x.open('GET', '/api/slow')
    x.onload = () => log(`xhr slow ${x.status}`)
    x.send()
  })
  on('btn-throw', () => {
    setTimeout(() => {
      throw new Error('Demo uncaught error')
    })
  })
  on('btn-reject', () => Promise.reject(new TypeError('Demo unhandled rejection')))
  on('btn-console', () => console.error('Demo console.error', { order: 42 }))
  on('btn-adderror', () => {
    const err = new Error('Demo handled error', { cause: new Error('root cause') })
    err.dd_context = { component: 'checkout' }
    window.DD_RUM.addError(err, { severity: 'high' })
  })
  on('btn-log', () => {
    window.DD_LOGS.logger.info('Demo info log', { order: { id: 42 } })
    window.DD_LOGS.logger.warn('Demo warn log')
  })
  on('btn-longtask', () => {
    const end = performance.now() + 300
    while (performance.now() < end) {
      /* busy */
    }
    log('long task done')
  })
  on('btn-mutate', () => {
    const p = document.createElement('p')
    p.textContent = `Added at ${new Date().toISOString()}`
    p.className = 'added'
    document.querySelector('.card:last-of-type').before(p)
  })
  on('btn-nav', () => {
    history.pushState({}, '', '/checkout/42')
    document.getElementById('title').textContent = 'Checkout 42'
    log('navigated')
  })
})
