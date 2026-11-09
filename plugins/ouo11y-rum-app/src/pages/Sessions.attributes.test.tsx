import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Sessions from './Sessions';

let search = new URLSearchParams('from=now-1h&to=now&attr.tenant=acme&bundle=b-1');
const partial = jest.fn();
jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  locationService: {
    getSearch: () => search,
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: (...args: unknown[]) => partial(...args),
    push: jest.fn(),
  },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

const sessions = jest.fn();
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  rumApi: { sessions: (...args: unknown[]) => sessions(...args) },
}));
jest.mock('../components/TimeRangeBar', () => ({
  ...jest.requireActual('../components/TimeRangeBar'),
  TimeRangeBar: () => null,
}));

describe('Sessions attribute and bundle filters (F1, F2)', () => {
  beforeEach(() => {
    search = new URLSearchParams('from=now-1h&to=now&attr.tenant=acme&bundle=b-1');
    partial.mockReset();
    sessions.mockReset();
    sessions.mockResolvedValue({ sessions: [], count: 0, from: '', to: '' });
  });

  it('sends attr.* and bundle from the URL to rum-api and lists the active attribute filters', async () => {
    render(<Sessions />);
    await screen.findByText('No sessions match');
    expect(sessions).toHaveBeenCalledWith(expect.objectContaining({ 'attr.tenant': 'acme', bundle: 'b-1' }));
    const chip = screen.getByRole('button', { name: 'Remove filter tenant=acme' });
    fireEvent.click(chip);
    expect(partial).toHaveBeenCalledWith({ 'attr.tenant': null }, true);
  });

  it('adds key=value typed in the Attribute box; a bad entry shows an error and changes nothing', async () => {
    render(<Sessions />);
    await screen.findByText('No sessions match');
    const box = screen.getByLabelText('Attribute filter');
    fireEvent.change(box, { target: { value: 'plan=pro' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(partial).toHaveBeenCalledWith({ 'attr.plan': 'pro' }, true);

    partial.mockReset();
    fireEvent.change(box, { target: { value: 'not-a-key=1' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(partial).not.toHaveBeenCalled();
    expect(screen.getByText(/The key is a letter/)).toBeInTheDocument();
  });

  it('Clear filters removes the attribute filters and the bundle too', async () => {
    render(<Sessions />);
    await screen.findByText('No sessions match');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(partial).toHaveBeenCalledWith(expect.objectContaining({ 'attr.tenant': null, bundle: null }), true);
  });
});
