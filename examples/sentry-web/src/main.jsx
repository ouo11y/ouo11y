import { Sentry } from './sentry.js';
import { scenarios } from './scenarios.js';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

function Boom() {
  throw new Error('demo: render error caught by ErrorBoundary');
}

function App() {
  const [boom, setBoom] = useState(false);
  const [out, setOut] = useState('');
  return (
    <main style={{ fontFamily: 'system-ui', padding: 16 }}>
      <h1>sentry-web demo (@sentry/react 11.11.0)</h1>
      <p>Visible text that replay masks by default.</p>
      <input id="secret" placeholder="type here" />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {Object.keys(scenarios).map(name => (
          <button
            key={name}
            id={`btn-${name}`}
            onClick={async () => setOut(JSON.stringify(await scenarios[name]()) ?? 'ok')}
          >
            {name}
          </button>
        ))}
        <button id="btn-boom" onClick={() => setBoom(true)}>react render error</button>
      </div>
      <pre id="out">{out}</pre>
      <Sentry.ErrorBoundary fallback={<p>ErrorBoundary fallback</p>}>{boom && <Boom />}</Sentry.ErrorBoundary>
    </main>
  );
}

createRoot(document.getElementById('root'), {
  onUncaughtError: Sentry.reactErrorHandler(),
  onCaughtError: Sentry.reactErrorHandler(),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
