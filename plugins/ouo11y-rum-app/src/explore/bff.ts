// The one client of the plugin's backend (ADR-0023): every request of the Session explorer
// pages goes through here, to the resources of the plugin's datasource
// (/api/datasources/uid/ouo11y/resources/v1/..., ADR-0024), with the Grafana session
// cookie. The backend applies Clearance; this file only fetches.
import { useEffect, useRef, useState } from 'react';
import { bffPaths, type ChunkFetcher, type Manifest, type Me, type SessionDetail, type SessionList } from '@ouo11y/kit';
import { BFF_DATASOURCE_UID } from '../constants';

export const BFF_BASE = `/api/datasources/uid/${BFF_DATASOURCE_UID}/resources`;

export class BffError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function get(path: string, query?: Record<string, string | number | undefined>): Promise<Response> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== '') {
      q.set(k, String(v));
    }
  }
  const url = `${BFF_BASE}/${path}${q.size ? `?${q}` : ''}`;
  const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json, */*' } });
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

export const bff = {
  me: async () => (await get(bffPaths.me())).json() as Promise<Me>,
  sessions: async (from: number, to: number) =>
    (await get(bffPaths.sessions(), { from, to })).json() as Promise<SessionList>,
  session: async (project: string, session: string, from?: number, to?: number) =>
    (await get(bffPaths.session(project, session), { from, to })).json() as Promise<SessionDetail>,
  manifest: async (project: string, session: string, replay: string) =>
    (await get(bffPaths.manifest(project, session, replay))).json() as Promise<Manifest>,
  chunkFetcher:
    (project: string, session: string, replay: string): ChunkFetcher =>
    async (stream, seq) =>
      (await get(bffPaths.chunk(project, session, replay, stream, seq))).arrayBuffer(),
};

export interface Async<T> {
  data?: T;
  error?: Error;
  loading: boolean;
}

/** Runs `fn` whenever `key` changes; the latest call wins (the pattern of hooks/useRumQuery). */
export function useBff<T>(fn: () => Promise<T>, key: string): Async<T> {
  const [result, setResult] = useState<{ key: string; data?: T; error?: Error }>({ key: '' });
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    let live = true;
    fnRef.current().then(
      (data) => live && setResult({ key, data }),
      (error: unknown) => live && setResult({ key, error: error instanceof Error ? error : new Error(String(error)) })
    );
    return () => {
      live = false;
    };
  }, [key]);
  const settled = result.key === key;
  return { data: settled ? result.data : undefined, error: settled ? result.error : undefined, loading: !settled };
}
