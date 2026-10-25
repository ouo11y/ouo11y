import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Symbolicated, TimelineEvent } from '../api/types';
import { frameCount, StackTrace } from './StackTrace';
import { Timeline } from './Timeline';

const STACK = `Error: coupon service unavailable
    at handledError (app:///main.jsbundle:1:1391274)
    at onPress (app:///main.jsbundle:1:1390001)`;

describe('StackTrace (C1)', () => {
  it('is collapsed with a frame count, expands on click, and does not bubble the click', () => {
    const onRow = jest.fn();
    render(
      <div onClick={onRow}>
        <StackTrace stack={STACK} />
      </div>
    );
    expect(screen.getByTestId('stack-toggle')).toHaveTextContent('Show stack trace (2 frames)');
    expect(screen.queryByTestId('stack-trace')).toBeNull();
    fireEvent.click(screen.getByTestId('stack-toggle'));
    expect(screen.getByTestId('stack-trace')).toHaveTextContent('at handledError (app:///main.jsbundle:1:1391274)');
    expect(onRow).not.toHaveBeenCalled();
  });

  it('renders nothing without a stack', () => {
    const { container } = render(<StackTrace stack={'  '} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on the original stack with source context and toggles to the raw one (ADR-0011)', () => {
    const raw =
      'RangeError: negative price\n    at o (https://shop.example/assets/app.min.js:1:64)\n    at c (https://shop.example/assets/vendor.js:1:9)';
    const sym: Symbolicated = {
      status: 'partial',
      mapped: 1,
      stacktrace:
        'RangeError: negative price\n    at totalOf (src/app.ts:10:13)\n    at c (https://shop.example/assets/vendor.js:1:9)',
      frames: [
        {
          status: 'mapped',
          generated: { file: 'https://shop.example/assets/app.min.js', line: 1, column: 64, function: 'o' },
          original: { file: 'src/app.ts', line: 10, column: 13, function: 'totalOf' },
          context: {
            pre: ['  for (const item of items) {', '    if (item.price < 0) {'],
            line: '      throw new RangeError("negative price");',
            post: ['    }'],
          },
        },
        {
          status: 'no_map',
          generated: { file: 'https://shop.example/assets/vendor.js', line: 1, column: 9, function: 'c' },
        },
      ],
    };
    render(<StackTrace stack={raw} symbolicated={sym} />);
    expect(screen.getByTestId('stack-symbolicated')).toHaveTextContent('source mapped 1/2');
    fireEvent.click(screen.getByTestId('stack-toggle'));
    const original = screen.getByTestId('stack-original');
    expect(original).toHaveTextContent('RangeError: negative price');
    const frames = screen.getAllByTestId('stack-frame');
    expect(frames[0]).toHaveTextContent('at totalOf (src/app.ts:10:13)');
    expect(frames[1]).toHaveTextContent('at c (https://shop.example/assets/vendor.js:1:9)');
    expect(screen.getByTestId('stack-context')).toHaveTextContent('10 throw new RangeError("negative price");');
    expect(screen.queryByTestId('stack-trace')).toBeNull();

    fireEvent.click(screen.getByTestId('stack-view-raw'));
    expect(screen.getByTestId('stack-trace')).toHaveTextContent('at o (https://shop.example/assets/app.min.js:1:64)');
    expect(screen.getByTestId('stack-view-raw')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('stack-view-original'));
    expect(screen.getByTestId('stack-original')).toBeInTheDocument();
  });

  it('shows the raw stack only when nothing was mapped', () => {
    const sym: Symbolicated = { status: 'no_maps', mapped: 0, stacktrace: STACK, frames: [] };
    render(<StackTrace stack={STACK} symbolicated={sym} defaultOpen />);
    expect(screen.queryByTestId('stack-symbolicated')).toBeNull();
    expect(screen.queryByTestId('stack-view-raw')).toBeNull();
    expect(screen.getByTestId('stack-trace')).toBeInTheDocument();
  });

  it('counts JS, Java-style and native frames', () => {
    expect(frameCount('Error\n  at a (x:1)\nb@y:2\n#0 0x1 foo')).toBe(3);
  });
});

describe('Timeline errors and clamped events', () => {
  beforeEach(() => {
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the stack of an exception and the recorded time of an event moved to the session start', () => {
    const start = Date.parse('2026-10-22T22:01:18.137Z');
    const timeline: TimelineEvent[] = [
      { ts: new Date(start).toISOString(), type: 'session.start', name: 'session.start', attrs: {} },
      {
        ts: new Date(start).toISOString(),
        type: 'navigation',
        name: 'navigation',
        attrs: { url_path: 'Home' },
        clampedFrom: new Date(start - 3600).toISOString(),
      },
      {
        ts: new Date(start + 49_000).toISOString(),
        type: 'exception',
        name: 'exception',
        attrs: {
          exception_type: 'Error',
          exception_message: 'coupon service unavailable',
          exception_stacktrace: STACK,
        },
      },
    ];
    render(<Timeline timeline={timeline} sessionStart={start} activeIndex={-1} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('+0.0s');
    expect(rows[1]).toHaveAttribute('data-clamped', 'true');
    expect(rows[1].getAttribute('title')).toContain('-3.6s: recorded before the session start');
    fireEvent.click(screen.getByTestId('stack-toggle'));
    expect(screen.getByTestId('stack-trace')).toHaveTextContent('at onPress');
  });

  it('shows and seeks a tap at its touch start, the time the activity list shows (F4 one clock)', () => {
    const start = Date.parse('2026-10-16T14:22:46.171Z');
    const onSeek = jest.fn();
    const tap: TimelineEvent = {
      ts: new Date(start + 11_500).toISOString(),
      type: 'custom',
      name: 'ui.tap',
      attrs: { ouo_ui_target: 'action-browse-catalog' },
    };
    render(
      <Timeline
        timeline={[tap]}
        sessionStart={start}
        activeIndex={-1}
        onSeek={onSeek}
        tapTimes={new Map([[0, start + 11_400]])}
      />
    );
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('+11.4s');
    fireEvent.click(row);
    expect(onSeek).toHaveBeenCalledWith(start + 11_400, tap);
  });
});
