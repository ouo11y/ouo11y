import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { HealthApp, HealthBucket, HealthResponse } from '../api/types';
import { groupByProject } from '../components/ProjectHealthGrid';
import Overview, { overviewLink, sessionsLink } from './Overview';

let mockSearch = 'from=now-24h&to=now';
jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  locationService: {
    getSearch: () => new URLSearchParams(mockSearch),
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: () => undefined,
  },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

const mockHealth = jest.fn();
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  rumApi: { health: (...a: unknown[]) => mockHealth(...a), projects: () => Promise.resolve({ projects: [] }) },
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

const counts = (total: number, healthy: number, errored: number, crashed: number) => ({
  total,
  healthy,
  errored,
  crashed,
  healthy_pct: Math.round((healthy / total) * 10000) / 100,
  errored_pct: Math.round((errored / total) * 10000) / 100,
  crashed_pct: Math.round((crashed / total) * 10000) / 100,
});
const app = (project_id: string, service_name: string, platform: string, c: ReturnType<typeof counts>): HealthApp => ({
  project_id,
  service_name,
  platforms: [platform],
  ...c,
});
const bucket = (
  project_id: string,
  platform: string,
  service_name: string,
  c: ReturnType<typeof counts>
): HealthBucket => ({
  project_id,
  platform,
  service_name,
  service_version: '1.0.0',
  ...c,
});

const health: HealthResponse = {
  buckets: [
    bucket('bank', 'web', 'bank-web', counts(4, 3, 1, 0)),
    bucket('shop', 'mobile', 'shop-rn', counts(2, 1, 0, 1)),
    bucket('shop', 'web', 'shop-web', counts(4, 4, 0, 0)),
  ],
  apps: [
    app('bank', 'bank-web', 'web', counts(4, 3, 1, 0)),
    app('shop', 'shop-rn', 'mobile', counts(2, 1, 0, 1)),
    app('shop', 'shop-web', 'web', counts(4, 4, 0, 0)),
  ],
  totals: { ...bucket('', '', '', counts(10, 8, 1, 1)), service_version: '' },
  from: '2026-11-03T10:00:00Z',
  to: '2026-11-04T10:00:00Z',
};

function renderOverview() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Overview />
    </MemoryRouter>
  );
}

describe('Overview scope', () => {
  beforeEach(() => mockHealth.mockReset().mockResolvedValue(health));

  it('shows every project with its apps side by side for all projects', async () => {
    mockSearch = 'from=now-24h&to=now';
    renderOverview();
    const grid = await screen.findByTestId('project-health-grid');
    expect(mockHealth).toHaveBeenCalledWith({ from: 'now-24h', to: 'now' });
    expect(screen.getByText('Projects and apps')).toBeInTheDocument();
    const shop = within(grid).getByTestId('project-shop');
    expect(shop).toHaveTextContent('6 sessions · 2 apps');
    expect(shop).toHaveTextContent('83.33% healthy');
    expect(within(grid).getByTestId('project-bank')).toHaveTextContent('75% healthy');
    // The app links scope the page to that app.
    expect(within(shop).getByRole('link', { name: 'shop-rn' })).toHaveAttribute(
      'href',
      '/a/ouo11y-rum-app/overview?from=now-24h&to=now&project=shop&service=shop-rn'
    );
    expect(within(shop).getByRole('link', { name: 'shop' })).toHaveAttribute(
      'href',
      '/a/ouo11y-rum-app/overview?from=now-24h&to=now&project=shop'
    );
    // The version table names the project when it mixes projects.
    expect(within(screen.getByTestId('platform-web')).getByText('Project')).toBeInTheDocument();
    expect(screen.getByText(/All projects, all platforms:/)).toBeInTheDocument();
  });

  it('sends the URL scope to rum-api and hides the grid for one app', async () => {
    mockSearch = 'from=now-6h&to=now&project=shop&service=shop-rn';
    mockHealth.mockResolvedValue({
      ...health,
      buckets: [health.buckets[1]],
      apps: [health.apps![1]],
      totals: { ...health.totals, ...counts(2, 1, 0, 1) },
    });
    renderOverview();
    await screen.findByTestId('platform-mobile');
    expect(mockHealth).toHaveBeenCalledWith({ from: 'now-6h', to: 'now', project: 'shop', service: 'shop-rn' });
    expect(screen.queryByTestId('project-health-grid')).toBeNull();
    expect(screen.getByText(/Scope shop \/ shop-rn:/)).toBeInTheDocument();
    // Links to the Sessions page keep the scope.
    expect(screen.getByRole('link', { name: 'All mobile sessions' })).toHaveAttribute(
      'href',
      '/a/ouo11y-rum-app/sessions?from=now-6h&to=now&platform=mobile&project=shop&service=shop-rn'
    );
  });

  it('shows the apps of one project when only the project is picked', async () => {
    mockSearch = 'from=now-24h&to=now&project=shop';
    mockHealth.mockResolvedValue({ ...health, apps: health.apps!.slice(1) });
    renderOverview();
    await screen.findByTestId('project-health-grid');
    expect(mockHealth).toHaveBeenCalledWith({ from: 'now-24h', to: 'now', project: 'shop' });
    expect(screen.getByText('Apps of shop')).toBeInTheDocument();
    expect(screen.queryByTestId('project-bank')).toBeNull();
  });

  it('works with a rum-api that has no apps field yet', async () => {
    mockSearch = 'from=now-24h&to=now';
    mockHealth.mockResolvedValue({ ...health, apps: undefined });
    renderOverview();
    await screen.findByTestId('platform-web');
    expect(screen.queryByTestId('project-health-grid')).toBeNull();
  });
});

describe('Overview links', () => {
  const range = { from: 'now-1h', to: 'now' };
  it('narrows a bucket link to its project and keeps the page scope', () => {
    expect(sessionsLink(health.buckets[0], range)).toBe(
      '/a/ouo11y-rum-app/sessions?from=now-1h&to=now&platform=web&project=bank&service=bank-web&version=1.0.0'
    );
    expect(sessionsLink({ ...health.totals, platform: 'web' }, range, { project: 'shop', service: '' })).toBe(
      '/a/ouo11y-rum-app/sessions?from=now-1h&to=now&platform=web&project=shop'
    );
  });
  it('builds scope links to the overview', () => {
    expect(overviewLink(range, { project: '', service: '' })).toBe('/a/ouo11y-rum-app/overview?from=now-1h&to=now');
  });
  it('groups apps by project with recomputed percentages', () => {
    const g = groupByProject(health.apps!);
    expect(g.map((p) => [p.project_id, p.total, p.healthy_pct])).toEqual([
      ['bank', 4, 75],
      ['shop', 6, 83.33],
    ]);
  });
});
