// A typed client of the BFF (ADR-0023). It only fetches: Clearance is applied by the backend,
// and a 403 comes back as a BffError with `forbidden` set, so a page can say "hidden by your
// clearance" instead of "broken".
import {
  bffPaths,
  type ChunkFetcher,
  type DroppedList,
  type FunnelList,
  type FunnelReport,
  type Manifest,
  type Me,
  type Outcome,
  type Overview,
  type Scope,
  type SessionDetail,
  type SessionList,
} from './api';

export class BffError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'BffError';
  }
  /** The caller's Clearance level does not allow this read. */
  get forbidden(): boolean {
    return this.status === 403;
  }
}

export interface BffClientOptions {
  /** Where the BFF answers; in Grafana `/api/plugins/<plugin id>/resources`. */
  baseUrl: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Added to every request (a token outside Grafana). */
  headers?: Record<string, string>;
}

export type Query = Record<string, string | number | undefined>;

export function createBffClient(opts: BffClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function get(path: string, query?: Query): Promise<Response> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== '') {
        q.set(k, String(v));
      }
    }
    const qs = q.toString(); // not q.size: older browsers and jsdom lack it
    const r = await doFetch(`${base}/${path}${qs ? `?${qs}` : ''}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json, */*', ...opts.headers },
    });
    if (!r.ok) {
      let msg = r.statusText;
      try {
        msg = ((await r.json()) as { error?: string }).error ?? msg;
      } catch {
        // not JSON
      }
      throw new BffError(r.status, msg);
    }
    return r;
  }
  const json = async <T>(path: string, query?: Query) => (await (await get(path, query)).json()) as T;
  const scope = (s: Scope = {}): Query => ({ from: s.from, to: s.to, project: s.project, platform: s.platform });

  return {
    get,
    me: (project?: string) => json<Me>(bffPaths.me(), { project }),
    sessions: (from?: number, to?: number, project?: string) => json<SessionList>(bffPaths.sessions(), { from, to, project }),
    session: (project: string, session: string, from?: number, to?: number) =>
      json<SessionDetail>(bffPaths.session(project, session), { from, to }),
    manifest: (project: string, session: string, replay: string) => json<Manifest>(bffPaths.manifest(project, session, replay)),
    chunkFetcher:
      (project: string, session: string, replay: string): ChunkFetcher =>
      async (stream, seq) =>
        (await get(bffPaths.chunk(project, session, replay, stream, seq))).arrayBuffer(),
    overview: (s?: Scope) => json<Overview>(bffPaths.overview(), scope(s)),
    funnels: () => json<FunnelList>(bffPaths.funnels()),
    funnel: (id: string, s?: Scope) => json<FunnelReport>(bffPaths.funnel(id), scope(s)),
    funnelDropped: (id: string, step: number, s?: Scope & { outcome?: Outcome; limit?: number }) =>
      json<DroppedList>(bffPaths.funnelDropped(id, step), { ...scope(s), outcome: s?.outcome, limit: s?.limit }),
  };
}

export type BffClient = ReturnType<typeof createBffClient>;
