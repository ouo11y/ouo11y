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
  /** rum-api after 0.3.0: duration (ms) of the session's `ouo.app.start`; absent when it has none. */
  app_start_ms?: number;
  /** rum-api after 0.3.0: `cold` or `warm`; absent when the session has no `ouo.app.start`. */
  app_start_type?: AppStartType | string;
}

export interface SessionsResponse {
  sessions: SessionRecord[];
  count: number;
  from: string;
  to: string;
}

export type TimelineType =
  | 'session.start'
  | 'navigation'
  | 'exception'
  | 'http.request.failed'
  | 'web_vital'
  | 'vital'
  | 'custom'
  | 'session.end';

/** A place in generated or original code (1-based line and column). */
export interface StackPosition {
  file: string;
  line: number;
  column: number;
  function?: string;
}

/** One frame of a symbolicated stack (ADR-0011). */
export interface SymbolicatedFrame {
  /** `mapped`: original position found; `no_map`: no map (or dSYM) for the script (or binary); `unmapped`: no mapping at the position. */
  status: 'mapped' | 'no_map' | 'unmapped';
  /** Native frames: the binary image's name as `file`, no line. */
  generated: StackPosition;
  original?: StackPosition;
  /** Original source lines around the frame, when the map embeds sourcesContent. */
  context?: { pre: string[]; line: string; post: string[] };
  debug_id?: string;
  /** Native frames (dSYM): the instruction address as reported. */
  address?: string;
  /** Native frames: the function was inlined into the next frame (same address). */
  inlined?: boolean;
}

/** rum-api after 0.3.0: an exception's stack mapped through its uploaded source maps. */
export interface Symbolicated {
  status: 'ok' | 'partial' | 'no_maps';
  /** Frames mapped; a native stack counts captured frames, not the rows of inlined functions. */
  mapped: number;
  frames: SymbolicatedFrame[];
  /** The stack text with original positions (lines that are not frames kept). */
  stacktrace: string;
}

export interface TimelineEvent {
  ts: string;
  type: TimelineType | string;
  name: string;
  attrs: Record<string, string>;
  /** Exceptions only: the stack through its source maps; `attrs.exception_stacktrace` stays raw. */
  symbolicated?: Symbolicated;
  /** Set by the plugin when it moved an event recorded before the session start to the start: the recorded time. */
  clampedFrom?: string;
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
  /** rum-api after 0.3.0: the root span's url.path when the root has a generic `HTTP {method}` name. */
  root_url_path?: string;
}

export interface SessionDetail extends SessionRecord {
  /**
   * rum-api after 0.3.0: the session's device, OS, build and environment (`device_model_identifier`,
   * `device_model_name`, `device_manufacturer`, `os_name`, `os_version`, `ouo_app_build`,
   * `deployment_environment_name`); absent on older versions or when no event carries them.
   */
  context?: Record<string, string>;
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
  /** Exception lines only: as on the timeline. */
  symbolicated?: Symbolicated;
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

/** Event names of the mobile vitals spec (docs/specs/mobile-vitals.md); timeline type `vital`. */
export type VitalName = 'ouo.app.start' | 'ouo.screen.display' | 'app.jank' | 'ouo.stall';
export type AppStartType = 'cold' | 'warm';
/** Display hint of mobile vitals spec section 4. */
export type VitalRating = 'good' | 'needs-improvement' | 'poor';

/** One record of GET /v1/sessions/{id}/vitals. */
export interface Vital {
  /** End of the measured interval. */
  ts: string;
  name: VitalName | string;
  /** `app.screen.name`, when the record has one. */
  screen?: string;
  trace_id?: string;
  span_id?: string;
  /**
   * Numeric attributes without their prefix (`ttid_ms`, `ttfd_ms`, `duration_ms`, `total`, `slow`, `frozen`,
   * `delay_ms`, `frame_count`, `period`, `threshold`, `count`, `total_ms`, `longest_ms`, `period_ms`) and `type`
   * (string) for app starts.
   */
  values: Record<string, number | string>;
  rating?: VitalRating;
}

/** Summary of GET /v1/sessions/{id}/vitals; a field is absent when the session has no record of that kind. */
export interface VitalsSummary {
  app_start?: { type: AppStartType | string; duration_ms: number; rating?: VitalRating };
  screens?: number;
  ttid_ms?: { p50: number; max: number };
  frames?: { total: number; slow: number; frozen: number; slow_ratio: number };
  stalls?: { count: number; total_ms: number; longest_ms: number };
}

export interface VitalsResponse {
  session_id: string;
  summary: VitalsSummary;
  vitals: Vital[];
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
  /** rum-api after 0.3.0: the chunk's `masked` flag, when it had one. */
  masked?: boolean;
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
  /**
   * rum-api after 0.3.0: false when any chunk was recorded unmasked, true when every chunk that says so is
   * masked; absent for rrweb, older rum-api versions and chunks without the flag.
   */
  masked?: boolean;
  updated_at: string;
  chunks: ReplayChunkMeta[];
}

export type FrameReason = 'timer' | 'touch' | 'navigation' | 'resume';
export type TouchPhase = 'began' | 'moved' | 'ended';

/** A rectangle of a patch frame, in pixels of the most recent full image (schema 2, ADR-0014). */
export interface ReplayPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Base64 JPEG of the rectangle. */
  jpeg: string;
}

/**
 * A frame holds exactly one of `jpeg` (a full image) and `patches` (rectangles drawn over the frame
 * before it). Schema 1 frames are always full images; every chunk starts with one.
 */
export interface ReplayFrame {
  /** Epoch ms (device clock). */
  ts: number;
  /** Base64 JPEG, masked by the SDK before upload. */
  jpeg?: string;
  patches?: ReplayPatch[];
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

/** A funnel step (docs/specs/funnels.md): a page path (exact or prefix) or a custom event name. */
export type FunnelStepKind = 'page' | 'event';
export type FunnelMatch = 'exact' | 'prefix';

export interface FunnelStep {
  kind: FunnelStepKind;
  /** Page steps only; exact when absent. */
  match?: FunnelMatch;
  value: string;
}

export interface FunnelFilters {
  service?: string;
  environment?: string;
  release?: string;
  platform?: string;
  project?: string;
}

export interface FunnelRequest {
  steps: FunnelStep[];
  from: string;
  to: string;
  /** Max time from step 1 to the last step, e.g. `30m`; empty for none. */
  within?: string;
  filters?: FunnelFilters;
}

export interface FunnelStepResult {
  step: FunnelStep;
  label: string;
  sessions: number;
  users: number;
  conversion_from_first: number;
  conversion_from_previous: number;
  dropped_off: number;
  median_ms: number | null;
  p75_ms: number | null;
}

export interface FunnelResponse {
  steps: FunnelStepResult[];
  sessions: number;
  users: number;
  within_ms: number | null;
  from: string;
  to: string;
}

export interface DroppedSession {
  session_id: string;
  user_id?: string;
  entered_at: string;
  last_step_at: string;
  last_path?: string;
  has_replay: boolean;
  replay_kind: ReplayKind | null;
}

export interface DroppedResponse {
  step: number;
  sessions: DroppedSession[];
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  from: string;
  to: string;
}

export interface StepSuggestion {
  value: string;
  count: number;
}

export interface StepSuggestionsResponse {
  pages: StepSuggestion[];
  events: StepSuggestion[];
  from: string;
  to: string;
}
