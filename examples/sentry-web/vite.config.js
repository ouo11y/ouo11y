import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Document-Policy: js-profiling enables the JS Self-Profiling API that browserProfilingIntegration needs.
const headers = { 'Document-Policy': 'js-profiling' };

// A local backend endpoint so fetch spans and trace propagation (sentry-trace, baggage, traceparent) can be observed.
function demoApi() {
  const handler = (req, res, next) => {
    if (!req.url.startsWith('/api/')) return next();
    const echo = {
      path: req.url,
      'sentry-trace': req.headers['sentry-trace'] ?? null,
      baggage: req.headers['baggage'] ?? null,
      traceparent: req.headers['traceparent'] ?? null,
    };
    const status = req.url.startsWith('/api/fail') ? 503 : 200;
    setTimeout(() => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(echo));
    }, 120);
  };
  return {
    name: 'demo-api',
    configureServer(s) { s.middlewares.use(handler); },
    configurePreviewServer(s) { s.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [react(), demoApi()],
  server: { headers },
  preview: { headers },
  build: { sourcemap: true },
});
