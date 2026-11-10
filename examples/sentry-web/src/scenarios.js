// Each scenario is a button in the UI and also window.demo.<name>() so a browser driver can call it.
import { Sentry } from './sentry.js';

function pngBytes() {
  const c = document.getElementById('cv');
  return new Promise(resolve => c.toBlob(b => b.arrayBuffer().then(a => resolve(new Uint8Array(a))), 'image/png'));
}

export const scenarios = {
  thrown() {
    setTimeout(() => {
      throw new Error('demo: thrown in a timer');
    });
  },
  rejection() {
    Promise.reject(new Error('demo: unhandled rejection'));
  },
  message() {
    return Sentry.captureMessage('demo: captureMessage info', 'info');
  },
  linked() {
    const inner = new TypeError('demo: inner cause');
    return Sentry.captureException(new Error('demo: outer error', { cause: inner }));
  },
  attachment() {
    return Sentry.withScope(scope => {
      scope.addAttachment({ filename: 'note.txt', data: 'hello from the demo', contentType: 'text/plain' });
      return Sentry.captureException(new Error('demo: error with attachment'));
    });
  },
  async fetchOk() {
    const r = await fetch('/api/hello');
    return r.json();
  },
  async fetchFail() {
    const r = await fetch('/api/fail');
    return r.status;
  },
  navigate() {
    const n = (Number(location.pathname.split('/').pop()) || 0) + 1;
    history.pushState({}, '', `/page/${n}${location.search}`);
    document.title = `page ${n}`;
  },
  manualSpan() {
    return Sentry.startSpan({ name: 'demo.work', op: 'function', attributes: { 'demo.kind': 'manual' } }, span => {
      let x = 0;
      for (let i = 0; i < 2e6; i++) x += Math.sqrt(i);
      span.setAttribute('demo.result', Math.round(x));
      return Sentry.spanToJSON(span).trace_id;
    });
  },
  logs() {
    Sentry.logger.info(Sentry.logger.fmt`user ${'demo-user-1'} opened ${'checkout'}`, { 'demo.step': 1 });
    Sentry.logger.warn('demo: low stock', { sku: 'A1' });
    Sentry.logger.error('demo: payment declined');
    console.warn('demo: console.warn captured as log');
  },
  metrics() {
    Sentry.metrics.count('demo.clicks', 1, { attributes: { button: 'metrics' } });
    Sentry.metrics.gauge('demo.cart_items', 3);
    Sentry.metrics.distribution('demo.render_ms', 42.5, { unit: 'millisecond' });
  },
  async feedback() {
    const data = await pngBytes();
    return Sentry.captureFeedback(
      { message: 'demo: feedback with screenshot', name: 'Demo User', email: 'demo@example.invalid' },
      { attachments: [{ filename: 'screenshot.png', data, contentType: 'image/png' }] },
    );
  },
  dropMe() {
    return Sentry.captureMessage('demo: drop-me please');
  },
  typeText() {
    const i = document.getElementById('secret');
    i.value = 'secret value 123';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  },
  drawCanvas() {
    const ctx = document.getElementById('cv').getContext('2d');
    ctx.fillStyle = `hsl(${Math.random() * 360} 70% 50%)`;
    ctx.fillRect(Math.random() * 250, Math.random() * 50, 40, 30);
  },
  async flush() {
    return Sentry.flush(5000);
  },
  replayId() {
    return Sentry.getReplay()?.getReplayId();
  },
  async replayFlush() {
    return Sentry.getReplay()?.flush();
  },
};

window.demo = scenarios;
window.Sentry = Sentry;
