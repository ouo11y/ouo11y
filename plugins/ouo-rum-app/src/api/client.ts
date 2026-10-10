import { lastValueFrom } from 'rxjs';
import { getBackendSrv, isFetchError } from '@grafana/runtime';
import { RUM_PROXY_BASE } from '../constants';
import type {
  HealthResponse,
  ReplayFramesResponse,
  ReplayMeta,
  RrwebEvent,
  SessionDetail,
  SessionFilters,
  SessionsResponse,
  TracesResponse,
} from './types';

export class RumApiError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'RumApiError';
  }
}

type Params = Record<string, string | number | undefined>;

export function buildUrl(path: string, params: Params = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === null) {
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return `${RUM_PROXY_BASE}${path}${query ? `?${query}` : ''}`;
}

function describeError(err: unknown, url: string): RumApiError {
  if (err instanceof RumApiError) {
    return err;
  }
  if (isFetchError(err)) {
    const data = err.data as { error?: string; message?: string } | string | undefined;
    const detail =
      typeof data === 'string' ? data : (data?.error ?? data?.message ?? err.statusText ?? 'request failed');
    const status = err.status;
    const hint =
      status === 502 || status === 503 || status === 504 || status === 0
        ? ' (is rum-api running and reachable from Grafana as configured in the plugin settings?)'
        : '';
    return new RumApiError(`${status ? `HTTP ${status}: ` : ''}${detail}${hint}`, url, status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new RumApiError(message, url);
}

export async function rumGet<T>(path: string, params: Params = {}): Promise<T> {
  const url = buildUrl(path, params);
  try {
    const response = await lastValueFrom(
      getBackendSrv().fetch<T>({
        url,
        method: 'GET',
        showErrorAlert: false,
        showSuccessAlert: false,
      })
    );
    return response.data;
  } catch (err) {
    throw describeError(err, url);
  }
}

export const rumApi = {
  health: (params: Params) => rumGet<HealthResponse>('/v1/stats/health', params),
  sessions: (filters: SessionFilters) => rumGet<SessionsResponse>('/v1/sessions', { ...filters }),
  session: (id: string, params: Params = {}) => rumGet<SessionDetail>(`/v1/sessions/${encodeURIComponent(id)}`, params),
  traces: (id: string) => rumGet<TracesResponse>(`/v1/sessions/${encodeURIComponent(id)}/traces`),
  replayMeta: (id: string) => rumGet<ReplayMeta>(`/v1/sessions/${encodeURIComponent(id)}/replay`),
  replayEvents: (id: string) => rumGet<RrwebEvent[]>(`/v1/sessions/${encodeURIComponent(id)}/replay/events`),
  replayFrames: (id: string) =>
    rumGet<ReplayFramesResponse>(`/v1/sessions/${encodeURIComponent(id)}/replay/frames`),
};
