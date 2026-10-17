export type Platform = 'web' | 'mobile';
/**
 * Replay renderer family: rrweb DOM events (web), native screenshot frames (mobile, ADR-0006) or
 * mp4 video segments (Sentry mobile Session Replay through the Sentry bridge, ADR-0008).
 */
export type ReplayKind = 'rrweb' | 'frames' | 'video';
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
  /** Set by rum-api from the replay meta; absent on older records (fall back to the replay meta). */
  replay_kind?: ReplayKind | null;
  /** Replay length (meta ended_at - started_at) in ms; null or absent when unknown or there is no replay. */
  replay_duration_ms?: number | null;
  /** Number of screenshot frames (`frames`) or encoded video frames (`video`); null or absent otherwise. */
  replay_frame_count?: number | null;
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

/** One line of GET /v1/sessions/{id}/logs. */
export interface LogLine {
  ts: string;
  service: string;
  level: string;
  body: string;
  event_name?: string;
  trace_id?: string;
  span_id?: string;
  /** `session`: the record carries the session id; `trace`: it shares one of the session's traces (backend logs). */
  source: 'session' | 'trace';
  trace_url?: string;
  attrs: Record<string, string>;
}

export interface LogsResponse {
  session_id: string;
  logs: LogLine[];
  count: number;
  truncated: boolean;
  /** Traces whose logs were joined; -1 when Tempo could not be searched. */
  trace_count: number;
  query: string;
  explore_url?: string;
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

export interface ReplayViewport {
  /** Points of the unscaled device viewport; touch coordinates are in this space. */
  width: number;
  height: number;
  /** Capture scale applied by the SDK (frame pixels = points * scale). */
  scale?: number;
}

export interface ReplayMeta {
  session_id: string;
  /** Missing on replays stored before Phase 7; treat as rrweb. */
  kind?: ReplayKind;
  /** Video replays only: `{vendor, replay_id}` of the first chunk that had one. */
  source?: ReplaySource | null;
  viewport?: ReplayViewport;
  platform?: string;
  frame_count?: number;
  touch_count?: number;
  chunk_count: number;
  first_seq: number;
  last_seq: number;
  started_at: number;
  ended_at: number;
  bytes: number;
  updated_at: string;
  chunks: ReplayChunkMeta[];
}

export type FrameReason = 'timer' | 'touch' | 'navigation' | 'resume';
export type TouchPhase = 'began' | 'moved' | 'ended';

export interface ReplayFrame {
  /** Epoch ms (device clock). */
  ts: number;
  /** Base64 JPEG, masked by the SDK before upload. */
  jpeg: string;
  reason: FrameReason | string;
}

export interface ReplayTouch {
  ts: number;
  /** Points in the unscaled viewport. */
  x: number;
  y: number;
  phase: TouchPhase | string;
}

/** `GET /v1/sessions/{id}/replay/frames`: all frame chunks concatenated in seq order. */
export interface ReplayFramesResponse {
  session_id: string;
  kind: 'frames';
  viewport: ReplayViewport;
  platform: string;
  started_at: number;
  ended_at: number;
  frames: ReplayFrame[];
  touches: ReplayTouch[];
}

/** Where a replay came from when it was not recorded by an ouo SDK (ADR-0008). */
export interface ReplaySource {
  vendor: string;
  replay_id?: string;
}

/** One mp4 segment of a video replay (one uploaded chunk, about 5 s at ~1 fps for Sentry). */
export interface VideoSegment {
  seq: number;
  /** Epoch ms. */
  started_at: number;
  ended_at: number;
  /** Media duration; rum-api falls back to `ended_at - started_at` when the chunk had none. */
  duration_ms: number;
  frame_count: number;
  /** mp4 size in bytes. */
  bytes: number;
  /** Relative to the rum-api root, e.g. `/v1/sessions/<id>/replay/video/0`. */
  path: string;
}

/** `GET /v1/sessions/{id}/replay/video`: the segment list of a video replay plus touches. */
export interface VideoManifest {
  session_id: string;
  kind: 'video';
  /** Pixel size of the video; touch x/y are in the same space. */
  viewport: ReplayViewport;
  platform: string;
  started_at: number;
  ended_at: number;
  segments: VideoSegment[];
  touches: ReplayTouch[];
  source: ReplaySource | null;
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
