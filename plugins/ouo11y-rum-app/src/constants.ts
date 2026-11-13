import pluginJson from './plugin.json';

export const PLUGIN_ID = pluginJson.id;
export const PLUGIN_BASE_URL = `/a/${PLUGIN_ID}`;

/** Plugin configuration page (jsonData.rumApiUrl, secureJsonData.readToken). */
export const PLUGIN_CONFIG_URL = `/plugins/${PLUGIN_ID}`;

/** Grafana proxies `routes[].path` of an app plugin under /api/plugin-proxy/<id>/<path>. */
export const RUM_PROXY_BASE = `/api/plugin-proxy/${PLUGIN_ID}/rum`;

/**
 * uid of the provisioned ouo11y-rum-datasource instance whose backend is the BFF (ADR-0024).
 * The Session explorer calls /api/datasources/uid/<uid>/resources/v1/...
 */
export const BFF_DATASOURCE_UID = 'ouo11y';

export const DEFAULT_RUM_API_URL = 'http://rum-api:8080';

export const DEFAULT_RANGE = { from: 'now-24h', to: 'now' } as const;

export enum ROUTES {
  Overview = 'overview',
  Sessions = 'sessions',
  Funnels = 'funnels',
  /** Session explorer on the BFF (ADR-0023). */
  Explore = 'explore',
}
