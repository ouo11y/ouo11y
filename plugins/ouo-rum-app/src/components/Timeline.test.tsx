import { eventLook } from './Timeline';
import type { TimelineEvent } from '../api/types';

const ev = (name: string, attrs: Record<string, string>, type = 'custom'): TimelineEvent => ({ ts: '2026-10-14T10:00:00Z', type, name, attrs });

describe('eventLook', () => {
  it('titles the events the Sentry bridge derives', () => {
    const log = ev('log', { message: 'payment failed: HTTP 500', ouo_sentry_level: 'error' });
    expect(eventLook(log).title(log)).toBe('Log (error)');
    expect(eventLook(log).detail(log)).toBe('payment failed: HTTP 500');

    const req = ev('http.request', { http_request_method: 'GET', url_full: 'http://localhost:8084/api/cart', http_response_status_code: '200' });
    expect(eventLook(req).title(req)).toBe('Request 200');
    expect(eventLook(req).detail(req)).toBe('GET http://localhost:8084/api/cart');

    const app = ev('app.lifecycle', { ouo_app_state: 'background' });
    expect(eventLook(app).title(app)).toBe('App background');

    const crumb = ev('breadcrumb', { ouo_breadcrumb_category: 'demo', message: 'promo opened', ouo_breadcrumb_data_promo: 'AUTUMN' });
    expect(eventLook(crumb).title(crumb)).toBe('demo');
    expect(eventLook(crumb).detail(crumb)).toBe('promo opened promo=AUTUMN');
  });

  it('keeps the generic look for other custom events and the typed looks', () => {
    const custom = ev('cart.added', { sku: 'sku-1' });
    expect(eventLook(custom).title(custom)).toBe('cart.added');
    expect(eventLook(custom).detail(custom)).toBe('sku=sku-1');

    // A web SDK event named like a bridge event but typed by rum-api keeps its type's look.
    const nav = ev('navigation', { url_path: '/cart' }, 'navigation');
    expect(eventLook(nav).detail(nav)).toBe('/cart');
  });
});
