import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionRecord } from '../api/types';
import { SessionsTable } from './SessionsTable';

function session(over: Partial<SessionRecord> & { session_id: string }): SessionRecord {
  return {
    user_id: null,
    platform: 'web',
    service_name: 'web-demo',
    service_version: '1.0.0',
    started_at: '2026-10-08T10:00:00Z',
    last_signal_at: '2026-10-08T10:01:00Z',
    ended_at: '2026-10-08T10:01:00Z',
    end_reason: 'inactivity',
    state: 'ended',
    status: 'healthy',
    error_count: 0,
    crash_count: 0,
    failed_request_count: 0,
    event_count: 1,
    trace_count: 0,
    has_replay: false,
    ...over,
  };
}

const sessions = [
  session({ session_id: 'older-crashed', started_at: '2026-10-08T09:00:00Z', status: 'crashed' }),
  session({
    session_id: 'newest-healthy',
    started_at: '2026-10-08T12:00:00Z',
    has_replay: true,
    replay_kind: 'rrweb',
    replay_duration_ms: 12_340,
  }),
  session({
    session_id: 'middle-errored',
    started_at: '2026-10-08T11:00:00Z',
    status: 'errored',
    has_replay: true,
    replay_kind: 'frames',
  }),
];

const rowIds = () =>
  screen
    .getAllByRole('link')
    .map((row) => row.getAttribute('data-session-id'))
    .filter((id): id is string => Boolean(id));

describe('SessionsTable', () => {
  it('sorts by started desc by default and flips when the header is clicked', () => {
    render(<SessionsTable sessions={sessions} onOpen={jest.fn()} />);
    expect(rowIds()).toEqual(['newest-healthy', 'middle-errored', 'older-crashed']);
    const table = screen.getByTestId('sessions-table');
    expect(table.getAttribute('data-sort-key')).toBe('started');
    expect(table.getAttribute('data-sort-dir')).toBe('desc');

    fireEvent.click(screen.getByTestId('sort-started'));
    expect(rowIds()).toEqual(['older-crashed', 'middle-errored', 'newest-healthy']);
    expect(table.getAttribute('data-sort-dir')).toBe('asc');
    expect(screen.getByTestId('sort-started').closest('th')?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('sorts by status severity and by replay length', () => {
    render(<SessionsTable sessions={sessions} onOpen={jest.fn()} />);
    fireEvent.click(screen.getByTestId('sort-status'));
    expect(rowIds()).toEqual(['newest-healthy', 'middle-errored', 'older-crashed']);
    fireEvent.click(screen.getByTestId('sort-status'));
    expect(rowIds()).toEqual(['older-crashed', 'middle-errored', 'newest-healthy']);

    fireEvent.click(screen.getByTestId('sort-replay'));
    expect(rowIds()).toEqual(['newest-healthy', 'middle-errored', 'older-crashed']);
    fireEvent.click(screen.getByTestId('sort-replay'));
    expect(rowIds()).toEqual(['older-crashed', 'middle-errored', 'newest-healthy']);
  });

  it('shows the replay length and kind, the play icon when the length is unknown, and a dash otherwise', () => {
    render(<SessionsTable sessions={sessions} onOpen={jest.fn()} />);
    const rows = screen.getAllByRole('link');
    const byId = (id: string) => rows.find((r) => r.getAttribute('data-session-id') === id)!;

    const rrweb = within(byId('newest-healthy')).getByTestId('replay-cell');
    expect(rrweb.textContent).toContain('12.3s');
    expect(rrweb.textContent).toContain('rrweb');
    expect(rrweb.getAttribute('data-replay-kind')).toBe('rrweb');

    const frames = within(byId('middle-errored')).getByTestId('replay-cell');
    expect(frames.textContent).toContain('frames');
    expect(frames.textContent).not.toMatch(/\d/);
    expect(frames.querySelector('svg')).not.toBeNull();

    expect(within(byId('older-crashed')).getByTestId('replay-none')).toBeInTheDocument();
  });

  it('opens a row on click and on Enter', () => {
    const onOpen = jest.fn();
    render(<SessionsTable sessions={sessions} onOpen={onOpen} />);
    const row = screen.getAllByRole('link')[0];
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen.mock.calls[0][0].session_id).toBe('newest-healthy');
  });
});
