import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Flows from './Flows';
import Home from './Home';

jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const SESSION = '0123456789abcdef0123456789abcdef';
const viewerMe = {
  login: 'v',
  role: 'Viewer',
  level: 1,
  can: { timeline: true, attributes: false, replay: false, identity: false, unmasked: false },
};

const step = (label: string, sessions: number, dropped: number, failed: number) => ({
  step: { kind: 'event', value: label, label },
  sessions,
  by_platform: { web: sessions - 1, ios: 1 },
  conversion_from_first: sessions * 10,
  conversion_from_previous: 50,
  dropped_off: dropped,
  failed,
  failure_rate: 10,
  median_ms: 2000,
  p75_ms: 3000,
});

function answer(url: string): unknown {
  if (url.includes('/v1/me')) {
    return viewerMe;
  }
  if (url.includes('/v1/overview')) {
    return {
      from: 1,
      to: 2,
      totals: { sessions: 10, errored: 2, crashed: 1, health: 80, crash_free: 90 },
      health: [{ project: 'demo', platform: 'web', sessions: 10, errored: 2, crashed: 1, health: 80, crash_free: 90 }],
      step_ms: 1000,
      sessions_over_time: [
        {
          platform: 'web',
          points: [
            [1, 4],
            [2, 6],
          ],
        },
      ],
      top_errors: [
        {
          fingerprint: 'fp1',
          project: 'demo',
          platforms: ['web'],
          count: 3,
          sessions: 2,
          fatal: false,
          last_seen: 5,
          session: SESSION,
        },
      ],
      web_vitals: [{ platform: 'web', name: 'lcp', unit: 'ms', p75: 2400, count: 9 }],
      mobile_vitals: [{ platform: 'ios', name: 'app_start_cold', unit: 'ms', p75: 850, count: 3 }],
      backend: [{ service: 'shop-api', rate_per_sec: 1.5, error_pct: 4, p95_ms: 120 }],
      truncated: false,
      redacted: ['attributes'],
    };
  }
  if (url.includes('/steps/')) {
    return {
      step: 3,
      outcome: 'failed',
      total: 1,
      truncated: false,
      redacted: ['identity'],
      sessions: [
        { project: 'demo', id: SESSION, platform: 'ios', last_step_at: 7, outcome: 'failed', failed_with: 'exception' },
      ],
    };
  }
  if (url.includes('/v1/funnels/shop')) {
    return {
      funnel: { id: 'shop', name: 'Shop', steps: [] },
      from: 1,
      to: 2,
      truncated: false,
      steps: [step('Browse', 10, 0, 0), step('Cart', 6, 4, 0), step('Pay', 3, 3, 1)],
    };
  }
  return { funnels: [{ id: 'shop', name: 'Shop', steps: [] }] };
}

beforeEach(() => {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: async () => answer(String(url)),
  })) as unknown as typeof fetch;
});

test('home shows health, errors without their message at c1, vitals and the backend from Mimir', async () => {
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>
  );
  expect(await screen.findByTestId('home-health')).toHaveTextContent('80 %');
  expect(screen.getByTestId('home-errors')).toHaveTextContent('fp1');
  expect(screen.getByTestId('home-web-vitals')).toHaveTextContent('2.40 s');
  expect(screen.getByTestId('home-mobile-vitals')).toHaveTextContent('Cold start');
  expect(screen.getByTestId('home-backend')).toHaveTextContent('shop-api');
  expect(screen.getByTestId('clearance-note')).toHaveTextContent('event attributes');
  expect(screen.getByText(new Date(5).toLocaleString()).closest('a')).toHaveAttribute(
    'href',
    expect.stringContaining(`/explore/demo/${SESSION}`)
  );
});

test('flows: a click on a failed drop-off lists the sessions with links to their page', async () => {
  render(
    <MemoryRouter>
      <Flows />
    </MemoryRouter>
  );
  expect(await screen.findAllByTestId('funnel-step')).toHaveLength(3);
  fireEvent.click(screen.getByTestId('funnel-failed'));
  expect(await screen.findByTestId('dropped-session-link')).toHaveAttribute(
    'href',
    expect.stringContaining(`/explore/demo/${SESSION}?from=1&to=2`)
  );
  expect(screen.getByTestId('funnel-dropped-list')).toHaveTextContent('failed: exception');
  expect(screen.getByTestId('funnel-dropped-list')).toHaveTextContent('hidden');
  await waitFor(() => {
    const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/v1/funnels/shop/steps/3/sessions?') && u.includes('outcome=failed'))).toBe(
      true
    );
  });
});
