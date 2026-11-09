import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { HealthBucket } from '../api/types';
import { VersionTable } from './VersionTable';

const bucket = (over: Partial<HealthBucket>): HealthBucket => ({
  platform: 'mobile',
  service_name: 'app',
  service_version: '1.0.0',
  total: 1,
  healthy: 1,
  errored: 0,
  crashed: 0,
  healthy_pct: 100,
  errored_pct: 0,
  crashed_pct: 0,
  ...over,
});

const renderTable = (buckets: HealthBucket[]) =>
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <VersionTable buckets={buckets} sessionsHref={(b) => `/s?version=${b.service_version}&bundle=${b.bundle_id ?? ''}`} />
    </MemoryRouter>
  );

describe('VersionTable', () => {
  it('has no Bundle column when no bucket has a bundle', () => {
    renderTable([bucket({}), bucket({ platform: 'web', service_version: '2.0.0', bundle_id: '' })]);
    expect(screen.queryByText('Bundle')).toBeNull();
    expect(screen.queryAllByTestId('version-table-bundle')).toHaveLength(0);
  });

  it('shows one row per version × bundle, the bundle linking to its sessions (F2)', () => {
    renderTable([bucket({}), bucket({ bundle_id: 'b-1', crashed: 1, crashed_pct: 100, healthy: 0, healthy_pct: 0 })]);
    expect(screen.getByText('Bundle')).toBeInTheDocument();
    const cells = screen.getAllByTestId('version-table-bundle');
    expect(cells[0]).toHaveTextContent('embedded / none');
    expect(within(cells[1]).getByText('b-1').closest('a')).toHaveAttribute('href', '/s?version=1.0.0&bundle=b-1');
  });
});
