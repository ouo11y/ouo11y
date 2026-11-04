import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// N30: the proxy routes decide who may call what on rum-api. Grafana 13 takes the first route
// whose method and path match, answers 403 when that route's reqRole is not met and 404 when no
// route matches (pkg/api/pluginproxy/pluginproxy.go), so a method that has no route is refused.
type Route = { path: string; method: string; reqRole?: string; url: string; headers?: Array<{ name: string }> };
const routes: Route[] = JSON.parse(readFileSync(join(__dirname, 'plugin.json'), 'utf8')).routes;

describe('plugin.json routes', () => {
  it('names one method per route, never "*" or an empty method (both match every method)', () => {
    for (const r of routes) {
      expect(['GET', 'POST', 'DELETE']).toContain(r.method);
    }
  });

  it('sets reqRole on every route (no reqRole lets every signed-in user through)', () => {
    for (const r of routes) {
      expect(['Viewer', 'Editor', 'Admin']).toContain(r.reqRole);
    }
  });

  it('gives Viewers reads only: GET everywhere, POST only for the funnel queries', () => {
    const viewer = routes.filter((r) => r.reqRole === 'Viewer').map((r) => `${r.method} ${r.path}`);
    expect(viewer.sort()).toEqual(['GET rum/*', 'POST rum/v1/funnels/*']);
  });

  it('keeps DELETE (replay erasure) for org Admins', () => {
    const del = routes.filter((r) => r.method === 'DELETE');
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ path: 'rum/v1/sessions/*', reqRole: 'Admin' });
  });

  it('maps a narrowed path back onto the same rum-api path and adds the read token', () => {
    for (const r of routes) {
      // Grafana strips the matched prefix and appends the `*` part to `url`.
      const prefix = r.path.replace(/^rum/, '').replace(/\/\*$/, '');
      expect(r.url.endsWith(`{{ end }}${prefix}`)).toBe(true);
      expect(r.headers?.map((h) => h.name)).toEqual(['Authorization']);
    }
  });
});
