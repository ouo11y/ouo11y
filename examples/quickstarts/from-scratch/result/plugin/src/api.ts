import { lastValueFrom } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import type { Manifest } from '@ouo11y/kit';
import { API } from './constants';

// The shapes ouo-go returns (libs/ouo-go/loki.go, muninn.go), as far as these pages read them.
export interface Session {
  project: string;
  id: string;
  service: string;
  start: number;
  end: number;
  event_count: number;
  error_count: number;
  has_replay: boolean;
  user?: string;
}
export interface Event {
  time: number;
  name: string;
  severity?: string;
  trace_id?: string;
  attributes?: Record<string, string>;
  body?: string;
}
export interface Replay {
  replay_id: string;
  state: string;
  formats: string[];
  chunk_count: number;
}

const get = <T,>(path: string) => getBackendSrv().get<T>(`${API}${path}`);

export const listSessions = () => get<{ sessions: Session[]; truncated: boolean }>('/sessions');

export const getSession = (project: string, session: string) =>
  get<{ session: Session; events: Event[]; replays: Replay[] }>(`/sessions/${project}/${session}`);

export const getManifest = (project: string, session: string, replay: string) =>
  get<Manifest>(`/sessions/${project}/${session}/replays/${replay}`);

// The chunk's bytes, as @ouo11y/kit's fetchChunk wants them.
export async function getChunk(p: string, s: string, r: string, stream: string, seq: number) {
  const res = await lastValueFrom(
    getBackendSrv().fetch<ArrayBuffer>({
      url: `${API}/sessions/${p}/${s}/replays/${r}/streams/${stream}/chunks/${seq}`,
      responseType: 'arraybuffer',
    })
  );
  return res.data;
}
