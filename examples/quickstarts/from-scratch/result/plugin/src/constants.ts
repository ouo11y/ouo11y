import pluginJson from './plugin.json';

// Where the app's pages live in Grafana, and where Grafana proxies calls to its backend.
export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;
export const API = `/api/plugins/${pluginJson.id}/resources`;
