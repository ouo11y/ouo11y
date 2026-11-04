// R3 live check (ADR-0019): payment journeys with known outcomes, posted as OTLP logs through the
// collector. cart.view -> checkout.submit {payment.method} -> payment.success, plus exceptions and
// payment.failed. Usage: OUO_OTLP_URL=http://localhost:4318 RUN_ID=a node r3-funnel-journeys.mjs
const OTLP = process.env.OUO_OTLP_URL ?? 'http://localhost:4318';
const BASIC = 'Basic ' + Buffer.from('demo:pt_dev_demo_0000000000000000').toString('base64');
const RUN = process.env.RUN_ID ?? Date.now().toString(36);
const str = (v) => ({ stringValue: String(v) });
const kv = (o) => Object.entries(o).map(([key, value]) => ({ key, value }));
const ns = (ms) => String(BigInt(ms) * 1_000_000n);

// [persona, count, steps]
const personas = [
  ['card-paid', 10, [['cart.view'], ['checkout.submit', { 'payment.method': 'card' }], ['payment.success']]],
  ['card-exception', 6, [['cart.view'], ['checkout.submit', { 'payment.method': 'card' }], ['exception', { 'exception.type': 'PaymentError', 'exception.message': 'card declined' }, 'PaymentError: card declined']]],
  ['card-abandon', 4, [['cart.view'], ['checkout.submit', { 'payment.method': 'card' }]]],
  ['paypal-paid', 5, [['cart.view'], ['checkout.submit', { 'payment.method': 'paypal' }], ['payment.success']]],
  ['cart-exception', 3, [['cart.view'], ['exception', { 'exception.type': 'TypeError', 'exception.message': 'cart broke' }, 'TypeError: cart broke']]],
  ['cart-abandon', 2, [['cart.view']]],
  ['card-declined', 2, [['cart.view'], ['checkout.submit', { 'payment.method': 'card' }], ['payment.failed', { reason: 'declined' }]]],
  ['hostile', 1, [['cart.view'], ['checkout.submit', { 'payment.method': 'card" or x="y' }]]],
];

const now = Date.now();
let base = now - 10 * 60_000;
const resourceLogs = [];
for (const [persona, n, steps] of personas) {
  for (let i = 0; i < n; i++) {
    const sid = `r3-${RUN}-${persona}-${i}`;
    let t = base;
    base += 2_000;
    const records = [];
    const ev = (name, attrs = {}, body = name) => {
      t += 1_000;
      records.push({
        timeUnixNano: ns(t),
        observedTimeUnixNano: ns(t),
        severityText: name === 'exception' ? 'ERROR' : 'INFO',
        severityNumber: name === 'exception' ? 17 : 9,
        eventName: name,
        body: str(body),
        attributes: kv({
          'event.name': str(name),
          'session.id': str(sid),
          'user.id': str(`u-${sid}`),
          'ouo.platform': str('web'),
          ...(name === 'exception' ? {} : { 'ouo.event.custom': { boolValue: true } }),
          ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, str(v)])),
        }),
      });
    };
    ev('session.start');
    ev('navigation', { 'url.path': '/cart', 'ouo.navigation.kind': 'load' });
    for (const [name, attrs, body] of steps) {
      ev(name, attrs, body);
    }
    resourceLogs.push({
      resource: {
        attributes: kv({
          'service.name': str('juhi-pay-web'),
          'service.version': str('1.0.0'),
          'deployment.environment.name': str('r3'),
          'ouo.platform': str('web'),
        }),
      },
      scopeLogs: [{ scope: { name: 'r3.journeys' }, logRecords: records }],
    });
  }
}

const res = await fetch(`${OTLP}/v1/logs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: BASIC },
  body: JSON.stringify({ resourceLogs }),
});
console.log('POST /v1/logs', res.status, await res.text(), 'sessions', resourceLogs.length, 'run', RUN);
