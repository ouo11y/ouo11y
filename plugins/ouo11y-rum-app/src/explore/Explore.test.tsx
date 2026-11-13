import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExploreSession from './ExploreSession';
import ExploreSessions from './ExploreSessions';

jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  locationService: {
    getSearch: () => new URLSearchParams(''),
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: () => undefined,
  },
}));
// rrweb-player is Svelte and needs a real layout; the player itself is tested in libs/ouo-kit.
jest.mock('rrweb-player', () => jest.fn());

const SESSION = '0123456789abcdef0123456789abcdef';
const viewerMe = {
  login: 'v',
  role: 'Viewer',
  level: 1,
  can: { timeline: true, attributes: false, replay: false, identity: false },
};

function answer(path: string): unknown {
  if (path.includes('/v1/me')) {
    return viewerMe;
  }
  if (path.includes('/v1/sessions')) {
    return {
      sessions: [
        {
          project: 'demo',
          id: SESSION,
          service: 'shop',
          start: 1,
          end: 61_000,
          event_count: 3,
          error_count: 1,
          has_replay: true,
        },
      ],
      truncated: false,
      redacted: ['attributes', 'replay', 'identity'],
    };
  }
  return {
    session: {
      project: 'demo',
      id: SESSION,
      service: 'shop',
      start: 1,
      end: 2,
      event_count: 1,
      error_count: 0,
      has_replay: false,
    },
    events: [{ time: 1, name: 'session.start' }],
    replays: null,
    traces: [{ trace_id: 'abc', root_service: 'shop', root_name: 'documentLoad', start: 1, duration_ms: 12 }],
    redacted: ['attributes', 'replay', 'identity'],
  };
}

beforeEach(() => {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => ({
    ok: true,
    status: 200,
    json: async () => answer(String(url)),
  })) as unknown as typeof fetch;
});

test('the list reads the BFF and says what clearance hid', async () => {
  render(
    <MemoryRouter>
      <ExploreSessions />
    </MemoryRouter>
  );
  expect(await screen.findByTestId('session-link')).toHaveAttribute(
    'href',
    expect.stringContaining(`/explore/demo/${SESSION}?from=`)
  );
  expect(screen.getByTestId('clearance-note')).toHaveTextContent('event attributes, replays, user identity');
  expect(screen.getByText('hidden')).toBeInTheDocument();
  const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
  expect(urls.every((u) => u.startsWith('/api/plugins/ouo11y-rum-app/resources/v1/'))).toBe(true);
});

test('below replay clearance the session page asks for no replay', async () => {
  render(
    <MemoryRouter initialEntries={[`/explore/demo/${SESSION}`]}>
      <Routes>
        <Route path="/explore/:project/:sessionId" element={<ExploreSession />} />
      </Routes>
    </MemoryRouter>
  );
  expect(await screen.findByTestId('replay-hidden')).toBeInTheDocument();
  expect(screen.getAllByTestId('timeline-event')).toHaveLength(1);
  expect(screen.getByTestId('explore-traces')).toHaveTextContent('documentLoad');
  expect(screen.getByText('documentLoad').closest('a')).toHaveAttribute(
    'href',
    expect.stringContaining('/explore?schemaVersion=1&panes=')
  );
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
  expect(urls.some((u) => u.includes('/replays/'))).toBe(false);
  expect(urls).toContain('/api/plugins/ouo11y-rum-app/resources/v1/me?project=demo');
});
