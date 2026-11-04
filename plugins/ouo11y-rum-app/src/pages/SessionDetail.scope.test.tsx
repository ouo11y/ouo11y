import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SessionDetail as Detail } from '../api/types';
import SessionDetail from './SessionDetail';

let mockSearch = 'from=now-7d&to=now&project=shop&service=shop-web';
jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
  locationService: {
    getSearch: () => new URLSearchParams(mockSearch),
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: () => undefined,
  },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

const api = { session: jest.fn(), logs: jest.fn(), replayMeta: jest.fn(), replayEvents: jest.fn(), vitals: jest.fn() };
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  rumApi: new Proxy({}, { get: (_t, k: string) => (api as Record<string, jest.Mock>)[k] }),
}));

// jsdom's URL has no canParse; Grafana's LinkButton sanitizes hrefs with it.
if (!('canParse' in URL)) {
  Object.assign(URL, {
    canParse: (u: string, base?: string) => {
      try {
        new URL(u, base);
        return true;
      } catch {
        return false;
      }
    },
  });
}

const detail: Detail = {
  session_id: 'shop-web-1',
  user_id: 'u1',
  project_id: 'shop',
  platform: 'web',
  service_name: 'shop-web',
  service_version: '1.0.0',
  started_at: '2026-11-04T10:00:00Z',
  last_signal_at: '2026-11-04T10:01:00Z',
  ended_at: '2026-11-04T10:01:00Z',
  end_reason: 'timeout',
  state: 'ended',
  status: 'healthy',
  error_count: 0,
  crash_count: 0,
  failed_request_count: 0,
  event_count: 1,
  trace_count: 0,
  has_replay: true,
  replay_kind: 'rrweb',
  timeline: [{ ts: '2026-11-04T10:00:00Z', type: 'session.start', name: 'session.start', attrs: {} }],
  traces: [],
};

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/sessions/shop-web-1']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/sessions/:id" element={<SessionDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('SessionDetail scope', () => {
  beforeEach(() => {
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    api.session.mockReset().mockResolvedValue(detail);
    api.logs
      .mockReset()
      .mockResolvedValue({ session_id: 'shop-web-1', logs: [], count: 0, truncated: false, trace_count: 0, query: '' });
    api.replayMeta.mockReset().mockResolvedValue({ session_id: 'shop-web-1', kind: 'rrweb', chunks: [] });
    api.replayEvents.mockReset().mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the scope on every call and keeps it in the links back', async () => {
    renderPage();
    expect(await screen.findByTestId('session-project')).toHaveTextContent('shop');
    const scope = { project: 'shop', service: 'shop-web' };
    expect(api.session).toHaveBeenCalledWith('shop-web-1', { from: 'now-7d', to: 'now', ...scope });
    await waitFor(() => expect(api.logs).toHaveBeenCalledWith('shop-web-1', { from: 'now-7d', to: 'now', ...scope }));
    await waitFor(() => expect(api.replayMeta).toHaveBeenCalledWith('shop-web-1', scope));
    await waitFor(() => expect(api.replayEvents).toHaveBeenCalledWith('shop-web-1', scope));
    expect(screen.getByRole('link', { name: /Back to sessions/ })).toHaveAttribute(
      'href',
      '/a/ouo11y-rum-app/sessions?from=now-7d&to=now&project=shop&service=shop-web'
    );
  });

  it('sends no scope for all projects', async () => {
    mockSearch = 'from=now-7d&to=now';
    renderPage();
    await screen.findByTestId('session-project');
    expect(api.session).toHaveBeenCalledWith('shop-web-1', { from: 'now-7d', to: 'now' });
    await waitFor(() => expect(api.replayMeta).toHaveBeenCalledWith('shop-web-1', {}));
  });
});
