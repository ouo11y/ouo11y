import { lastValueFrom } from 'rxjs';
import { getBackendSrv, isFetchError } from '@grafana/runtime';
import { RUM_PROXY_BASE } from '../constants';
import type {
  HealthResponse,
  LogsResponse,
  ReplayFramesResponse,
  ReplayMeta,
  RrwebEvent,
  SessionDetail,
  SessionFilters,
  SessionsResponse,
  TracesResponse,
  VideoManifest,
  VideoSegment,
  VitalsResponse,
} from './types';

/** Shown whenever rum-api answers 401 (ADR-0007 section 6: the read token is missing or wrong). */
export const READ_TOKEN_REJECTED = 'rum-api rejected the read token';

export class RumApiError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'RumApiError';
  }

  /**
   * True when rum-api answered 401. Grafana itself never answers 401 through the plugin proxy
   * for a signed-in user (missing role is 403), so a 401 here always means the read token the
   * proxy adds from secureJsonData.readToken does not match OUO_READ_TOKEN.
   */
  get unauthorized(): boolean {
    return this.status === 401;
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
    if (status === 401) {
      return new RumApiError(
        `HTTP 401: ${READ_TOKEN_REJECTED} (${detail}). Set the read token in the plugin settings to the OUO_READ_TOKEN value rum-api was started with.`,
        url,
        401
      );
    }
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
  /** Liveness probe, open without a token; proves the proxy reaches rum-api at jsonData.rumApiUrl. */
  healthz: () => rumGet<unknown>('/healthz'),
  health: (params: Params) => rumGet<HealthResponse>('/v1/stats/health', params),
  sessions: (filters: SessionFilters) => rumGet<SessionsResponse>('/v1/sessions', { ...filters }),
  session: (id: string, params: Params = {}) => rumGet<SessionDetail>(`/v1/sessions/${encodeURIComponent(id)}`, params),
  traces: (id: string) => rumGet<TracesResponse>(`/v1/sessions/${encodeURIComponent(id)}/traces`),
  logs: (id: string, params: Params = {}) =>
    rumGet<LogsResponse>(`/v1/sessions/${encodeURIComponent(id)}/logs`, params),
  vitals: (id: string, params: Params = {}) =>
    rumGet<VitalsResponse>(`/v1/sessions/${encodeURIComponent(id)}/vitals`, params),
  replayMeta: (id: string) => rumGet<ReplayMeta>(`/v1/sessions/${encodeURIComponent(id)}/replay`),
  replayEvents: (id: string) => rumGet<RrwebEvent[]>(`/v1/sessions/${encodeURIComponent(id)}/replay/events`),
  replayFrames: (id: string) => rumGet<ReplayFramesResponse>(`/v1/sessions/${encodeURIComponent(id)}/replay/frames`),
  replayVideo: (id: string) => rumGet<VideoManifest>(`/v1/sessions/${encodeURIComponent(id)}/replay/video`),
};

/**
 * Browser URL of one mp4 segment. The manifest `path` is relative to the rum-api root; it is mapped
 * onto the plugin proxy route so Grafana adds the read token server-side and a `<video src>` (which
 * cannot set headers) is authenticated by the Grafana session cookie. The proxy passes `Range`
 * through (206), so the element can stream and seek. Falls back to the canonical path when the
 * manifest has none or it is not a `/v1/` path.
 */
export function videoSegmentUrl(sessionId: string, segment: Pick<VideoSegment, 'seq' | 'path'>): string {
  const path =
    typeof segment.path === 'string' && segment.path.startsWith('/v1/')
      ? segment.path
      : `/v1/sessions/${encodeURIComponent(sessionId)}/replay/video/${segment.seq}`;
  return `${RUM_PROXY_BASE}${path}`;
}
