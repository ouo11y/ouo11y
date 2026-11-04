import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { ProjectsResponse } from '../api/types';
import {
  ALL_APPS,
  ALL_PROJECTS,
  ALL_PROJECTS_VALUE,
  appOptions,
  appValue,
  pickApp,
  pickProject,
  projectOptions,
  ScopePicker,
} from './ScopePicker';

// jsdom has no canvas; Grafana's Combobox measures option text with one.
HTMLCanvasElement.prototype.getContext = (() => ({
  measureText: (t: string) => ({ width: t.length * 7 }),
  font: '',
})) as unknown as HTMLCanvasElement['getContext'];

let mockSearch = 'from=now-6h&to=now';
const mockPartial = jest.fn();
jest.mock('@grafana/runtime', () => ({
  locationService: {
    getSearch: () => new URLSearchParams(mockSearch),
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: (...args: unknown[]) => mockPartial(...args),
  },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

const mockProjects = jest.fn();
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  rumApi: { projects: (...args: unknown[]) => mockProjects(...args) },
}));

const data: ProjectsResponse = {
  projects: [
    { project_id: 'bank', sessions: 4, apps: [{ service_name: 'bank-web', platforms: ['web'], sessions: 4 }] },
    {
      project_id: 'shop',
      sessions: 10,
      apps: [
        { service_name: 'shop-rn', platforms: ['mobile'], sessions: 3 },
        { service_name: 'shop-web', platforms: ['web'], sessions: 7 },
      ],
    },
  ],
  unscoped_sessions: 0,
  from: '',
  to: '',
};

describe('scope options', () => {
  it('lists all projects first, then each project with its app and session counts', () => {
    const opts = projectOptions(data, { project: '', service: '' });
    expect(opts.map((o) => o.label)).toEqual([ALL_PROJECTS, 'bank', 'shop']);
    expect(opts[0].value).toBe(ALL_PROJECTS_VALUE);
    expect(opts[2].description).toBe('2 apps, 10 sessions');
  });

  it('keeps a selected project that has no sessions in the range', () => {
    const opts = projectOptions(data, { project: 'gone', service: '' });
    expect(opts[opts.length - 1]).toEqual({ label: 'gone', value: 'gone', description: 'no sessions in range' });
  });

  it('lists every app across projects for all projects, labelled with the project', () => {
    const opts = appOptions(data, { project: '', service: '' });
    expect(opts.map((o) => o.label)).toEqual([ALL_APPS, 'bank-web · bank', 'shop-rn · shop', 'shop-web · shop']);
    expect(opts[2].value).toBe(appValue('shop', 'shop-rn'));
    expect(opts[2].description).toBe('mobile, 3 sessions');
  });

  it('lists only the apps of the selected project', () => {
    const opts = appOptions(data, { project: 'shop', service: '' });
    expect(opts.map((o) => o.label)).toEqual([ALL_APPS, 'shop-rn', 'shop-web']);
    expect(opts[0].value).toBe(appValue('shop', ''));
  });

  it('keeps an app filter from the URL that is not in the list', () => {
    expect(appOptions(data, { project: '', service: 'legacy' }).pop()).toMatchObject({
      label: 'legacy · all projects',
      value: appValue('', 'legacy'),
    });
    expect(appOptions(data, { project: 'shop', service: 'old' }).pop()).toMatchObject({
      label: 'old',
      description: 'no sessions in range',
    });
  });

  it('picking a project keeps the app only when that project has it', () => {
    expect(pickProject(data, { project: '', service: 'shop-web' }, 'shop')).toEqual({
      project: 'shop',
      service: 'shop-web',
    });
    expect(pickProject(data, { project: 'shop', service: 'shop-web' }, 'bank')).toEqual({
      project: 'bank',
      service: '',
    });
    expect(pickProject(data, { project: 'shop', service: 'shop-web' }, ALL_PROJECTS_VALUE)).toEqual({
      project: '',
      service: 'shop-web',
    });
  });

  it('picking an app sets its project too; all apps keeps the project', () => {
    expect(pickApp(appValue('shop', 'shop-rn'))).toEqual({ project: 'shop', service: 'shop-rn' });
    expect(pickApp(appValue('shop', ''))).toEqual({ project: 'shop', service: '' });
    expect(pickApp(appValue('', ''))).toEqual({ project: '', service: '' });
  });
});

describe('ScopePicker', () => {
  beforeEach(() => {
    mockProjects.mockReset();
    mockPartial.mockReset();
  });

  it('loads the options for the page time range and shows the URL scope', async () => {
    mockSearch = 'from=now-6h&to=now&project=shop&service=shop-web';
    mockProjects.mockResolvedValue(data);
    render(<ScopePicker />);
    await waitFor(() => expect(mockProjects).toHaveBeenCalledWith({ from: 'now-6h', to: 'now' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue('shop'));
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveValue('shop-web');
    expect(screen.getByTestId('scope-info')).toBeInTheDocument();
  });

  it('defaults to all projects and all apps', async () => {
    mockSearch = 'from=now-24h&to=now';
    mockProjects.mockResolvedValue(data);
    render(<ScopePicker />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(ALL_PROJECTS));
    expect(screen.getByRole('combobox', { name: 'App' })).toHaveValue(ALL_APPS);
  });

  it('flags a failed project list without blocking the page', async () => {
    mockSearch = 'from=now-24h&to=now';
    mockProjects.mockRejectedValue(new Error('HTTP 502: loki down'));
    render(<ScopePicker />);
    expect(await screen.findByTestId('scope-error')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(ALL_PROJECTS);
  });
});
