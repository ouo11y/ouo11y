// Measures the tree-shaken production bundle of @sentry/browser 11.11.0 for cumulative feature sets.
// Each variant is built as a Vite app (Rollup tree-shaking, esbuild minify, default target) from a tiny entry that only calls init.
// Output: raw, gzip (level 9) and brotli (quality 11) bytes of the emitted JS. Usage: npm run size
import { build } from 'vite';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { join } from 'node:path';

const dsn = 'https://public@example.invalid/1';
const steps = [
  ['errors (default integrations)', [], ''],
  ['+ tracing', ['browserTracingIntegration'], 'tracesSampleRate: 1,'],
  ['+ replay', ['replayIntegration'], 'replaysSessionSampleRate: 0.1, replaysOnErrorSampleRate: 1,'],
  ['+ replay canvas', ['replayCanvasIntegration'], ''],
  ['+ feedback', ['feedbackIntegration'], ''],
  ['+ profiling', ['browserProfilingIntegration'], 'profileSessionSampleRate: 1,'],
];
const only = [
  ['replay only (errors + replay)', ['replayIntegration'], 'replaysOnErrorSampleRate: 1,'],
  ['feedback only (errors + feedback)', ['feedbackIntegration'], ''],
  ['logs + metrics used (errors + logger/metrics calls)', [], '', "Sentry.logger.info('x'); Sentry.metrics.count('x', 1);"],
];

const root = new URL('../.size/', import.meta.url).pathname;
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

function entry(integrations, opts, extra = '') {
  return `import * as Sentry from '@sentry/browser';
Sentry.init({ dsn: '${dsn}', ${opts} integrations: [${integrations.map(i => `Sentry.${i}()`).join(', ')}] });
${extra}`;
}

async function measure(name, integrations, opts, extra) {
  const dir = join(root, name.replace(/[^a-z0-9]+/gi, '_'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'entry.js'), entry(integrations, opts, extra));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./entry.js"></script>');
  await build({
    logLevel: 'silent',
    configFile: false,
    root: dir,
    build: { outDir: join(dir, 'dist'), minify: 'esbuild', sourcemap: false, modulePreload: false },
    define: { __SENTRY_DEBUG__: 'false' },
    resolve: { alias: {} },
  });
  const files = readdirSync(join(dir, 'dist', 'assets')).filter(f => f.endsWith('.js')).map(f => join('assets', f));
  let raw = 0, gz = 0, br = 0;
  for (const f of files) {
    const b = readFileSync(join(dir, 'dist', f));
    raw += b.length;
    gz += gzipSync(b, { level: 9 }).length;
    br += brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  }
  return { name, files: files.length, raw, gz, br };
}

const rows = [];
let acc = [], accOpts = '';
for (const [name, ints, opts] of steps) {
  acc = [...acc, ...ints];
  accOpts += opts;
  rows.push(await measure(name, acc, accOpts));
}
for (const [name, ints, opts, extra] of only) rows.push(await measure(name, ints, opts, extra));
const kb = n => (n / 1024).toFixed(1);
console.log('| Variant | JS files | raw KiB | gzip KiB | brotli KiB |\n|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.files} | ${kb(r.raw)} | ${kb(r.gz)} | ${kb(r.br)} |`);
