import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { DroppedResponse, FunnelResponse, FunnelStepResult } from '../api/types';
import { FunnelChart } from '../components/FunnelChart';
import Funnels, { funnelHref } from './Funnels';

let search = new URLSearchParams();
const partial = jest.fn();
const replace = jest.fn();
const push = jest.fn();

jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  locationService: {
    getSearch: () => search,
    getLocation: () => ({ pathname: '/a/ouo11y-rum-app/funnels' }),
    getLocationObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
    partial: (...a: unknown[]) => partial(...a),
    replace: (...a: unknown[]) => replace(...a),
    push: (...a: unknown[]) => push(...a),
  },
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

// jsdom has no canvas; Grafana's Combobox measures option text with one.
HTMLCanvasElement.prototype.getContext = (() => ({
  measureText: (t: string) => ({ width: t.length * 7 }),
  font: '',
})) as unknown as HTMLCanvasElement['getContext'];

const api = { funnel: jest.fn(), funnelDropped: jest.fn(), funnelSteps: jest.fn() };
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  rumApi: new Proxy({}, { get: (_t, k: string) => (api as Record<string, jest.Mock>)[k] }),
}));

function row(label: string, sessions: number, over: Partial<FunnelStepResult> = {}): FunnelStepResult {
  const [kind, value] = label.split(/:(.*)/s);
  return {
    step: kind === 'page' ? { kind: 'page', match: 'exact', value } : { kind: 'event', value },
    label,
    sessions,
    users: sessions,
    conversion_from_first: 0,
    conversion_from_previous: 0,
    dropped_off: 0,
    failed: 0,
    failure_rate: 0,
    median_ms: null,
    p75_ms: null,
    ...over,
  };
}

const notTruncated = { truncated: false, truncated_reads: [], events_read_limit: 100_000, complete_until: null };

const report: FunnelResponse = {
  steps: [
    row('page:/', 50, { conversion_from_first: 100 }),
    row('event:add_to_cart', 20, {
      conversion_from_first: 40,
      conversion_from_previous: 40,
      dropped_off: 30,
      median_ms: 12_000,
      p75_ms: 30_000,
    }),
    row('event:order_paid', 5, {
      conversion_from_first: 10,
      conversion_from_previous: 25,
      dropped_off: 15,
      median_ms: 65_000,
      p75_ms: 90_000,
    }),
  ],
  sessions: 50,
  users: 41,
  failed: 0,
  failure: { kind: 'event', value: 'exception' },
  within_ms: null,
  from: '2026-10-24T00:00:00Z',
  to: '2026-10-24T01:00:00Z',
  ...notTruncated,
};

const droppedPage: DroppedResponse = {
  step: 3,
  sessions: [
    {
      session_id: 'sess-dropped-1',
      user_id: 'user-1',
      entered_at: '2026-10-24T00:10:00Z',
      last_step_at: '2026-10-24T00:11:00Z',
      last_path: '/cart',
      outcome: 'abandoned',
      has_replay: true,
      replay_kind: 'rrweb',
    },
  ],
  outcome: '',
  ...notTruncated,
  total: 15,
  offset: 0,
  limit: 25,
  next_offset: null,
  from: report.from,
  to: report.to,
};

beforeEach(() => {
  jest.clearAllMocks();
  api.funnel.mockResolvedValue(report);
  api.funnelDropped.mockResolvedValue(droppedPage);
  api.funnelSteps.mockResolvedValue({
    pages: [{ value: '/', count: 50 }],
    events: [{ value: 'add_to_cart', count: 20 }],
    from: '',
    to: '',
  });
});

describe('Funnels page', () => {
  it('queries the steps from the URL and draws the funnel', async () => {
    search = new URLSearchParams(
      'from=now-1h&to=now&step=page:/&step=event:add_to_cart&step=event:order_paid&service=shop&within=30m'
    );
    render(<Funnels />);
    expect(await screen.findByText('10.0%')).toBeInTheDocument();
    expect(api.funnel).toHaveBeenCalledWith({
      steps: [
        { kind: 'page', match: 'exact', value: '/' },
        { kind: 'event', value: 'add_to_cart' },
        { kind: 'event', value: 'order_paid' },
      ],
      from: 'now-1h',
      to: 'now',
      within: '30m',
      filters: { service: 'shop' },
    });
    expect(screen.getByText(/50 sessions \(41 users\) entered; 5 completed/)).toBeInTheDocument();
    expect(screen.getByText(/median 12\.0s · p75 30\.0s/)).toBeInTheDocument();
  });

  it('does not query an incomplete funnel', async () => {
    search = new URLSearchParams('step=page:/');
    render(<Funnels />);
    expect(await screen.findByText('Add at least two steps.')).toBeInTheDocument();
    expect(api.funnel).not.toHaveBeenCalled();
  });

  it('writes step edits to the URL', async () => {
    search = new URLSearchParams('step=page:/&step=event:add_to_cart');
    render(<Funnels />);
    await screen.findByText('10.0%');
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    const q = new URLSearchParams(replace.mock.calls[0][0].search);
    expect(q.getAll('step')).toEqual(['page:/', 'event:add_to_cart', 'event:']);
  });

  it('lists the sessions dropped at a step and opens one', async () => {
    search = new URLSearchParams(
      'from=now-1h&to=now&step=page:/&step=event:add_to_cart&step=event:order_paid&dropped=3'
    );
    render(<Funnels />);
    const panel = await screen.findByLabelText('Sessions dropped before step 3');
    expect(await within(panel).findByText('/cart')).toBeInTheDocument();
    expect(api.funnelDropped).toHaveBeenCalledWith(
      expect.objectContaining({ steps: 'page:/,event:add_to_cart,event:order_paid', step: 3, offset: 0, limit: 25 })
    );
    fireEvent.click(within(panel).getByRole('button', { name: /Replay/ }));
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/sessions/sess-dropped-1?'));
  });
});

describe('FunnelChart', () => {
  it('reports clicks on a drop-off segment', () => {
    const onDropOff = jest.fn();
    render(<FunnelChart steps={report.steps} onDropOff={onDropOff} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 30 sessions dropped before step 2' }));
    expect(onDropOff).toHaveBeenCalledWith(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

it('builds shareable funnel links', () => {
  expect(
    funnelHref(
      [
        { kind: 'page', match: 'prefix', value: '/p/' },
        { kind: 'event', value: 'paid' },
      ],
      { from: 'now-7d' }
    )
  ).toBe('/a/ouo11y-rum-app/funnels?from=now-7d&step=page%3A%2Fp%2F*&step=event%3Apaid');
});

describe('Funnels page: conditions and failures (ADR-0019)', () => {
  const payReport: FunnelResponse = {
    ...report,
    steps: [
      row('event:cart.view', 50, { conversion_from_first: 100 }),
      row('event:checkout.submit', 30, {
        step: { kind: 'event', value: 'checkout.submit', where: [{ key: 'payment.method', op: '=', value: 'card' }] },
        label: 'event:checkout.submit where payment.method=card',
        conversion_from_first: 60,
        conversion_from_previous: 60,
        dropped_off: 20,
        failed: 4,
        failure_rate: 8,
      }),
      row('event:payment.success', 21, {
        conversion_from_first: 42,
        conversion_from_previous: 70,
        dropped_off: 9,
        failed: 6,
        failure_rate: 20,
      }),
    ],
    failed: 10,
  };
  const failedPage: DroppedResponse = {
    ...droppedPage,
    outcome: 'failed',
    total: 6,
    sessions: [
      {
        session_id: 'sess-failed-1',
        entered_at: '2026-10-24T00:10:00Z',
        last_step_at: '2026-10-24T00:11:00Z',
        outcome: 'failed',
        failed_at: '2026-10-24T00:11:02Z',
        failure_event: 'exception',
        failure_message: 'PaymentError: card declined',
        has_replay: true,
        replay_kind: 'rrweb',
      },
    ],
  };
  const card = 'event:checkout.submit where payment.method=card';

  it('sends conditional steps and shows them in the step editor', async () => {
    api.funnel.mockResolvedValue(payReport);
    search = new URLSearchParams();
    search.append('step', 'event:cart.view');
    search.append('step', card);
    search.append('step', 'event:payment.success');
    render(<Funnels />);
    expect(await screen.findByText('42.0%')).toBeInTheDocument();
    expect(api.funnel).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          { kind: 'event', value: 'cart.view' },
          { kind: 'event', value: 'checkout.submit', where: [{ key: 'payment.method', op: '=', value: 'card' }] },
          { kind: 'event', value: 'payment.success' },
        ],
        failure: undefined,
      })
    );
    expect(screen.getByLabelText('Step 2 condition 1 attribute')).toHaveValue('payment.method');
    expect(screen.getByLabelText('Step 2 condition 1 value')).toHaveValue('card');
    expect(screen.getByText(/10 stopped after exception/)).toBeInTheDocument();
    expect(screen.getByText(/8\.0% failure rate/)).toBeInTheDocument();
    expect(screen.getByText(/20\.0% failure rate/)).toBeInTheDocument();
  });

  it('writes a new condition to the URL on blur', async () => {
    api.funnel.mockResolvedValue(payReport);
    search = new URLSearchParams('step=event:cart.view&step=event:checkout.submit');
    render(<Funnels />);
    await screen.findByText('42.0%');
    fireEvent.click(screen.getByRole('button', { name: 'Step 2 add condition' }));
    const key = screen.getByLabelText('Step 2 condition 1 attribute');
    const value = screen.getByLabelText('Step 2 condition 1 value');
    fireEvent.change(key, { target: { value: 'payment.method' } });
    fireEvent.change(value, { target: { value: 'credit card' } });
    expect(replace).not.toHaveBeenCalled();
    fireEvent.blur(value);
    const q = new URLSearchParams(replace.mock.calls[0][0].search);
    expect(q.getAll('step')).toEqual(['event:cart.view', 'event:checkout.submit where payment.method="credit card"']);
  });

  it('opens the failed sessions of a step from its failed count', async () => {
    api.funnel.mockResolvedValue(payReport);
    search = new URLSearchParams();
    search.append('step', 'event:cart.view');
    search.append('step', 'event:checkout.submit');
    search.append('step', 'event:payment.success');
    render(<Funnels />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show 6 sessions failed before step 3' }));
    expect(partial).toHaveBeenCalledWith({ dropped: '3', outcome: 'failed', offset: null }, true);
  });

  it('lists the failed sessions of a step with the failure and a replay link', async () => {
    api.funnel.mockResolvedValue(payReport);
    api.funnelDropped.mockResolvedValue(failedPage);
    search = new URLSearchParams();
    search.append('step', 'event:cart.view');
    search.append('step', card);
    search.append('step', 'event:payment.success');
    search.append('failure', 'event:payment.failed where reason=declined');
    search.set('dropped', '3');
    search.set('outcome', 'failed');
    render(<Funnels />);
    const panel = await screen.findByLabelText('Sessions dropped before step 3');
    expect(await within(panel).findByText('PaymentError: card declined')).toBeInTheDocument();
    expect(within(panel).getByText('Failed before step 3 · 6 sessions')).toBeInTheDocument();
    expect(api.funnelDropped).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: `event:cart.view,${card},event:payment.success`,
        step: 3,
        outcome: 'failed',
        failure: 'event:payment.failed where reason=declined',
      })
    );
    fireEvent.click(within(panel).getByRole('button', { name: /Replay/ }));
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/sessions/sess-failed-1?'));
  });

  it('changes the failure event on demand', async () => {
    search = new URLSearchParams('step=page:/&step=event:add_to_cart&failure=off');
    render(<Funnels />);
    expect(await screen.findByText('off')).toBeInTheDocument();
    expect(screen.queryByLabelText('Failure event')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change failure event' }));
    expect(screen.getByLabelText('Failure event')).toBeInTheDocument();
  });

  it('warns when a Loki read was cut at the cap', async () => {
    api.funnel.mockResolvedValue({
      ...report,
      truncated: true,
      truncated_reads: ['pages'],
      complete_until: '2026-10-24T00:40:00Z',
    });
    search = new URLSearchParams('step=page:/&step=event:add_to_cart&step=event:order_paid');
    render(<Funnels />);
    expect(await screen.findByText('Partial funnel: the Loki read limit was reached')).toBeInTheDocument();
    expect(screen.getByText(/page views read stopped at 100,000 events/)).toBeInTheDocument();
  });

  it('hides failed counts when failure tracking is off', async () => {
    api.funnel.mockResolvedValue({ ...report, failure: null });
    search = new URLSearchParams('step=page:/&step=event:add_to_cart&step=event:order_paid&failure=off&dropped=3');
    render(<Funnels />);
    await screen.findByText('10.0%');
    expect(api.funnel).toHaveBeenCalledWith(expect.objectContaining({ failure: { off: true } }));
    expect(screen.queryByText(/failure rate/)).not.toBeInTheDocument();
    const panel = await screen.findByLabelText('Sessions dropped before step 3');
    await within(panel).findByText('/cart');
    expect(within(panel).queryByText('Outcome')).not.toBeInTheDocument();
  });
});
