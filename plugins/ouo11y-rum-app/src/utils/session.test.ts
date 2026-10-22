import type { TimelineEvent } from '../api/types';
import {
  clampToSessionStart,
  exceptionSummary,
  isExceptionLine,
  logLineText,
  previousSessionId,
  sessionContextFields,
  traceDisplayName,
} from './session';

const start = Date.parse('2026-10-16T14:22:46.171Z');
const ev = (offsetMs: number, type: string, name = type, attrs: Record<string, string> = {}): TimelineEvent => ({
  ts: new Date(start + offsetMs).toISOString(),
  type,
  name,
  attrs,
});

describe('clampToSessionStart (C4)', () => {
  it('moves events recorded before the session start to it, after session.start, keeping the recorded time', () => {
    const tl = [
      ev(-3600, 'navigation', 'navigation', { url_path: 'Home' }),
      ev(0, 'session.start'),
      ev(100, 'custom', 'console'),
    ];
    const out = clampToSessionStart(tl, start);
    expect(out.map((e) => e.type)).toEqual(['session.start', 'navigation', 'custom']);
    expect(Date.parse(out[1].ts)).toBe(start);
    expect(out[1].clampedFrom).toBe(tl[0].ts);
    expect(out[0].clampedFrom).toBeUndefined();
    expect(out[2]).toBe(tl[2]);
  });

  it('leaves a timeline without early events as it is', () => {
    const tl = [ev(0, 'session.start'), ev(10, 'navigation'), ev(5, 'custom', 'log')];
    expect(clampToSessionStart(tl, start)).toEqual(tl);
    expect(clampToSessionStart(tl, NaN)).toEqual(tl);
  });

  it('clamps without a session.start event too', () => {
    const out = clampToSessionStart([ev(-50, 'navigation'), ev(20, 'exception')], start);
    expect(out.map((e) => Date.parse(e.ts) - start)).toEqual([0, 20]);
  });
});

describe('sessionContextFields (C2)', () => {
  it('builds device, OS, build and environment from the detail context', () => {
    const f = sessionContextFields({
      service_version: '1.4.0',
      timeline: [],
      context: {
        device_model_identifier: 'iPhone19,2',
        device_manufacturer: 'Apple',
        os_name: 'iOS',
        os_version: '27.0',
        ouo_app_build: '42',
        deployment_environment_name: 'staging',
      },
    });
    expect(f).toEqual([
      { label: 'Device', value: 'Apple iPhone19,2' },
      { label: 'OS', value: 'iOS 27.0' },
      { label: 'Build', value: '1.4.0 (build 42)' },
      { label: 'Environment', value: 'staging' },
    ]);
  });

  it('shows the model name with the identifier, and falls back to the timeline attributes of older rum-api', () => {
    const f = sessionContextFields({
      service_version: '1.0.0',
      timeline: [
        ev(0, 'session.start', 'session.start', {
          device_model_identifier: 'iPhone19,2',
          device_model_name: 'iPhone 18 Pro',
        }),
      ],
    });
    expect(f).toEqual([{ label: 'Device', value: 'iPhone 18 Pro (iPhone19,2)' }]);
  });

  it('leaves out what is unknown', () => {
    expect(sessionContextFields({ service_version: '1', timeline: [] })).toEqual([]);
  });
});

describe('traceDisplayName (C6)', () => {
  it('names a generic HTTP root by method and path, like the bridge names its spans', () => {
    expect(traceDisplayName({ root_name: 'HTTP GET', root_url_path: '/api/products/p-1001' })).toBe(
      'GET /api/products/p-1001'
    );
    expect(traceDisplayName({ root_name: 'POST', root_url_path: '/api/checkout' })).toBe('POST /api/checkout');
  });

  it('keeps named roots and generic roots without a path', () => {
    expect(traceDisplayName({ root_name: 'GET /api/cart', root_url_path: '/ignored' })).toBe('GET /api/cart');
    expect(traceDisplayName({ root_name: 'HTTP GET' })).toBe('HTTP GET');
    expect(traceDisplayName({ root_name: 'Checkout' })).toBe('Checkout');
    expect(traceDisplayName({ root_name: '' })).toBe('(no root span)');
  });
});

describe('log lines (C7)', () => {
  const exceptionLine = {
    body: 'exception',
    event_name: 'exception',
    attrs: { exception_type: 'Error', exception_message: 'coupon service unavailable', session_previous_id: 'x' },
  };

  it('shows exception records as type and message', () => {
    expect(isExceptionLine(exceptionLine)).toBe(true);
    expect(logLineText(exceptionLine)).toBe('Error: coupon service unavailable');
    expect(exceptionSummary({ exception_message: 'only a message' })).toBe('only a message');
  });

  it('keeps the body of other lines, and of exceptions without type or message', () => {
    expect(logLineText({ body: 'checkout ok', attrs: {} })).toBe('checkout ok');
    expect(logLineText({ body: 'boom', event_name: 'exception', attrs: {} })).toBe('boom');
  });
});

describe('previousSessionId', () => {
  it('reads session.previous_id from session.start, else from any record', () => {
    expect(previousSessionId([ev(0, 'session.start', 'session.start', { session_previous_id: 'p1' })])).toBe('p1');
    expect(previousSessionId([ev(0, 'session.start'), ev(5, 'custom', 'log', { session_previous_id: 'p2' })])).toBe(
      'p2'
    );
    expect(previousSessionId([ev(0, 'session.start')])).toBeUndefined();
  });
});
