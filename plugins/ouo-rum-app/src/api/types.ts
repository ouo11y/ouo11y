export type Platform = 'web' | 'mobile';
export type SessionStatus = 'healthy' | 'errored' | 'crashed';
export type SessionState = 'active' | 'ended';

export interface SessionRecord {
  session_id: string;
  user_id: string | null;
  platform: Platform | string;
  service_name: string;
  service_version: string;
  started_at: string;
  last_signal_at: string;
  ended_at: string | null;
  end_reason: string | null;
  state: SessionState | string;
  status: SessionStatus | string;
  error_count: number;
  crash_count: number;
  failed_request_count: number;
  event_count: number;
  /** -1 when Tempo failed for that session. */
  trace_count: number;
  has_replay: boolean;
}

export interface SessionsResponse {
  sessions: SessionRecord[];
  count: number;
  from: string;
  to: string;
}

export type TimelineType =
  'session.start' | 'navigation' | 'exception' | 'http.request.failed' | 'web_vital' | 'custom' | 'session.end';

export interface TimelineEvent {
  ts: string;
  type: TimelineType | string;
  name: string;
  attrs: Record<string, string>;
}

export interface TraceSummary {
  trace_id: string;
  root_name: string;
  root_service: string;
  start: string;
  duration_ms: number;
  span_count: number;
  has_error: boolean;
  grafana_url: string;
}

export interface SessionDetail extends SessionRecord {
  timeline: TimelineEvent[];
  traces: TraceSummary[];
}

export interface TracesResponse {
  session_id: string;
  traces: TraceSummary[];
  count: number;
}

export interface HealthBucket {
  platform: string;
  service_name: string;
  service_version: string;
  total: number;
  healthy: number;
  errored: number;
  crashed: number;
  healthy_pct: number;
  errored_pct: number;
  crashed_pct: number;
}

export interface HealthResponse {
  buckets: HealthBucket[];
  totals: HealthBucket;
  from: string;
  to: string;
}

export interface ReplayChunkMeta {
  seq: number;
  started_at: number;
  ended_at: number;
  bytes: number;
  event_count: number;
}

export interface ReplayMeta {
  session_id: string;
  chunk_count: number;
  first_seq: number;
  last_seq: number;
  started_at: number;
  ended_at: number;
  bytes: number;
  updated_at: string;
  chunks: ReplayChunkMeta[];
}

/** Minimal rrweb event shape; the full type lives in @rrweb/types. */
export interface RrwebEvent {
  type: number;
  timestamp: number;
  data: unknown;
}

export interface SessionFilters {
  from?: string;
  to?: string;
  platform?: string;
  status?: string;
  version?: string;
  user?: string;
  service?: string;
  limit?: number;
}
