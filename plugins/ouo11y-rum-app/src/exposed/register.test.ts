import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppPlugin } from '@grafana/data';
import { clampLimit } from './SessionsList';
import { embedSearch, rangeValue } from './EmbedRoot';
import { EXPOSED_COMPONENT_META, registerExposedComponents } from './register';
import { EXPOSED_COMPONENT_IDS } from './types';

jest.mock('@grafana/runtime', () => ({
  PluginPage: () => null,
  locationService: {},
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

type Declared = { id: string; title: string; description: string };
const pluginJson = JSON.parse(readFileSync(join(__dirname, '..', 'plugin.json'), 'utf8'));
const declared: Declared[] = pluginJson.extensions?.exposedComponents ?? [];

describe('exposed component contract (ADR-0019)', () => {
  it('names every id <plugin id>/<component>/v<major>', () => {
    for (const id of Object.values(EXPOSED_COMPONENT_IDS)) {
      expect(id).toMatch(new RegExp(`^${pluginJson.id}/[a-z][a-z-]*/v\\d+$`));
    }
  });

  it('keeps the v1 ids: renaming or dropping one breaks every host that embeds it', () => {
    expect(Object.values(EXPOSED_COMPONENT_IDS).sort()).toEqual([
      'ouo11y-rum-app/overview-health/v1',
      'ouo11y-rum-app/session-detail/v1',
      'ouo11y-rum-app/sessions-list/v1',
    ]);
  });

  it('declares in plugin.json exactly what module.tsx registers (Grafana drops undeclared ones)', () => {
    const plugin = registerExposedComponents(new AppPlugin());
    const registered = plugin.exposedComponentConfigs.map(({ id, title, description }) => ({ id, title, description }));
    expect(registered).toHaveLength(3);
    expect([...declared].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...registered].sort((a, b) => a.id.localeCompare(b.id))
    );
    for (const c of plugin.exposedComponentConfigs) {
      expect(EXPOSED_COMPONENT_META[c.id as keyof typeof EXPOSED_COMPONENT_META]).toBeDefined();
      expect(typeof c.component).toBe('function');
    }
  });

  it('requires a Grafana that has exposed components and usePluginComponent on both sides', () => {
    expect(pluginJson.dependencies.grafanaDependency).toBe('>=13.0.0');
  });
});

describe('embed query', () => {
  it('passes relative and ISO ends through and turns epoch milliseconds into ISO', () => {
    expect(rangeValue('now-6h', 'x')).toBe('now-6h');
    expect(rangeValue('2026-11-03T00:00:00Z', 'x')).toBe('2026-11-03T00:00:00Z');
    expect(rangeValue(1762128000000, 'x')).toBe('2025-11-03T00:00:00.000Z');
    expect(rangeValue('1762128000000', 'x')).toBe('2025-11-03T00:00:00.000Z');
    expect(rangeValue(undefined, 'now-24h')).toBe('now-24h');
    expect(rangeValue('  ', 'now')).toBe('now');
    expect(rangeValue(Number.NaN, 'now')).toBe('now');
  });

  it("maps app to ouo's `service` key and leaves empty scope out", () => {
    expect(embedSearch({ project: 'shop', app: 'shop-ios' }).toString()).toBe(
      'from=now-24h&to=now&project=shop&service=shop-ios'
    );
    expect(embedSearch({ project: '', timeRange: { from: 'now-1h', to: 'now' } }).toString()).toBe(
      'from=now-1h&to=now'
    );
  });

  it('clamps the sessions list limit to 1..1000, default 100', () => {
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit(0)).toBe(100);
    expect(clampLimit(-5)).toBe(100);
    expect(clampLimit(25.7)).toBe(25);
    expect(clampLimit(5000)).toBe(1000);
  });
});
