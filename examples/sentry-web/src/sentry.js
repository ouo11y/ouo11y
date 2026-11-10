// Sentry setup for the Step 6 research demo. URL parameters switch scenarios:
//   ?replay=buffer   replaysSessionSampleRate 0, onError 1 (buffer / on-error mode). Default: session mode (rate 1).
//   ?canvas=1        add replayCanvasIntegration
//   ?static=1        traceLifecycle 'static' (legacy transaction events). Default in v11: 'stream' (span v2 items)
//   ?drop=1          beforeSend drops events whose message contains "drop-me" (forces a client_report)
//   ?offline=1       makeBrowserOfflineTransport (IndexedDB queue)
//   ?tap=4522        send to another sentrytap port (e.g. a sink answering 429)
//   ?sample=0        sampleRate 0 for errors (forces client_report reason sample_rate)
import * as Sentry from '@sentry/react';

const params = new URLSearchParams(location.search);
const flag = name => params.get(name);

let dsn = import.meta.env.VITE_SENTRY_DSN;
if (flag('tap')) dsn = dsn.replace(':4520/', `:${flag('tap')}/`);

const integrations = [
  Sentry.browserTracingIntegration(),
  Sentry.replayIntegration({
    // Defaults kept on purpose (maskAllText, maskAllInputs, blockAllMedia) so fixtures show masking.
    networkDetailAllowUrls: [location.origin + '/api/'],
  }),
  Sentry.feedbackIntegration({ autoInject: true, enableScreenshot: true, colorScheme: 'system' }),
  Sentry.browserProfilingIntegration(),
  Sentry.httpClientIntegration(),
  Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
];
if (flag('canvas')) integrations.push(Sentry.replayCanvasIntegration());

Sentry.init({
  dsn,
  debug: true,
  release: 'sentry-web-demo@1.0.0',
  environment: 'step6',
  integrations,
  ...(flag('static') ? { traceLifecycle: 'static' } : {}),
  ...(flag('sample') ? { sampleRate: Number(flag('sample')) } : {}),
  tracesSampleRate: 1.0,
  tracePropagationTargets: ['localhost', /^\//],
  propagateTraceparent: true,
  replaysSessionSampleRate: flag('replay') === 'buffer' ? 0 : 1.0,
  replaysOnErrorSampleRate: 1.0,
  profileSessionSampleRate: 1.0,
  profileLifecycle: 'trace',
  ...(flag('offline')
    ? { transport: Sentry.makeBrowserOfflineTransport(Sentry.makeFetchTransport), transportOptions: { flushAtStartup: true } }
    : {}),
  beforeSend(event) {
    if (flag('drop') && JSON.stringify(event).includes('drop-me')) return null;
    return event;
  },
});

Sentry.setUser({ id: 'demo-user-1' });
Sentry.setTag('demo', 'step6');

export { Sentry };
