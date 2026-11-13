// The BFF's answers (ADR-0023 section 3), mirrored from ouo-go's Go types. Fields a Clearance
// level does not see are absent, and `redacted` names the groups that were removed.

export type FieldGroup = 'attributes' | 'replay' | 'identity';

export interface Capabilities {
  timeline: boolean;
  attributes: boolean;
  replay: boolean;
  identity: boolean;
  /** Replays recorded without masking (c5). */
  unmasked: boolean;
}

/** GET v1/me[?project=] */
export interface Me {
  login: string;
  role: string;
  /** The Clearance teams the user is in. */
  teams?: string[];
  /** The level for `project` when asked, else the org level. */
  level: number;
  /** Per-project levels that differ from the org's. */
  projects?: Record<string, number>;
  project?: string;
  can: Capabilities;
}

/** One trace of a session, from Tempo's search (timeline-level: c1). */
export interface TraceSummary {
  trace_id: string;
  root_service: string;
  root_name: string;
  start: number;
  duration_ms: number;
}

export interface Session {
  project: string;
  id: string;
  service: string;
  /** ms since the epoch */
  start: number;
  end: number;
  event_count: number;
  error_count: number;
  /** A hint from Loki's reference records; Muninn is the authority. */
  has_replay: boolean;
  /** Present from identity clearance (c4). */
  user?: string;
}

/** GET v1/sessions */
export interface SessionList {
  sessions: Session[];
  truncated: boolean;
  redacted: FieldGroup[];
}

export interface Event {
  time: number;
  name: string;
  severity?: string;
  view_id?: string;
  trace_id?: string;
  span_id?: string;
  /** Present from attributes clearance (c2); identity attributes from c4. Names use "_" for ".". */
  attributes?: Record<string, string>;
  body?: string;
}

export interface ReplaySummary {
  replay_id: string;
  state: 'open' | 'complete' | 'partial';
  start_time: number;
  end_time: number;
  chunk_count: number;
  byte_size: number;
  formats: string[];
  stream_count: number;
}

/** GET v1/projects/{project}/sessions/{session} */
export interface SessionDetail {
  session: Session;
  events: Event[];
  /** null without replay clearance (c3). */
  replays: ReplaySummary[] | null;
  replays_error?: string;
  /** null when the BFF has no Tempo. */
  traces: TraceSummary[] | null;
  traces_error?: string;
  /** More events in the range than one read returns. */
  truncated: boolean;
  redacted: FieldGroup[];
}

export interface ChunkEntry {
  sequence: number;
  segment_index: number;
  keyframe: boolean;
  start_time: number;
  end_time: number;
  format: string;
  encoding: string;
  byte_size: number;
  sha256: string;
  received_at: number;
  attributes: Record<string, unknown> | null;
}

export interface StreamEntry {
  stream_id: string;
  state: string;
  start_time: number;
  end_time: number;
  missing: Array<[number, number]> | null;
  chunks: ChunkEntry[] | null;
}

/** GET v1/projects/{project}/sessions/{session}/replays/{replay} (Muninn spec 7.2). */
export interface Manifest {
  session_id: string;
  replay_id: string;
  project: string;
  state: string;
  start_time: number;
  end_time: number;
  chunk_count: number;
  byte_size: number;
  streams: StreamEntry[] | null;
}

/** Fetches one chunk's decompressed bytes from the BFF. */
export type ChunkFetcher = (streamId: string, sequence: number) => Promise<ArrayBuffer>;

/** BFF paths, relative to the BFF's base URL (in Grafana: /api/plugins/ouo11y-rum-app/resources). */
export const bffPaths = {
  me: () => 'v1/me',
  sessions: () => 'v1/sessions',
  session: (project: string, session: string) => `v1/projects/${project}/sessions/${session}`,
  manifest: (project: string, session: string, replay: string) =>
    `v1/projects/${project}/sessions/${session}/replays/${replay}`,
  chunk: (project: string, session: string, replay: string, stream: string, sequence: number) =>
    `v1/projects/${project}/sessions/${session}/replays/${replay}/streams/${stream}/chunks/${sequence}`,
  overview: () => 'v1/overview',
  funnels: () => 'v1/funnels',
  funnel: (id: string) => `v1/funnels/${encodeURIComponent(id)}`,
  funnelDropped: (id: string, step: number) => `v1/funnels/${encodeURIComponent(id)}/steps/${step}/sessions`,
};

/** A condition on an event step: the attribute as the SDK names it, `=` by default. */
export interface Condition {
  key: string;
  op?: '=' | '!=' | '=~';
  value: string;
}

export interface FunnelStep {
  kind: 'page' | 'event';
  value: string;
  prefix?: boolean;
  where?: Condition[];
  label?: string;
}

/** A provisioned funnel definition (ADR-0025). */
export interface Funnel {
  id: string;
  name: string;
  description?: string;
  steps: FunnelStep[];
  within_seconds?: number;
  failure?: FunnelStep | null;
  no_failure?: boolean;
  project?: string;
}

/** GET v1/funnels */
export interface FunnelList {
  funnels: Funnel[];
  /** Definitions that did not validate (Admins only). */
  invalid?: string[];
}

export interface FunnelStepResult {
  step: FunnelStep;
  sessions: number;
  by_platform: Record<string, number>;
  conversion_from_first: number;
  conversion_from_previous: number;
  dropped_off: number;
  /** The part of dropped_off that stopped after a failure event. */
  failed: number;
  failure_rate: number;
  median_ms: number | null;
  p75_ms: number | null;
}

/** GET v1/funnels/{id} (counts only: c1). */
export interface FunnelReport {
  funnel: Funnel;
  from: number;
  to: number;
  steps: FunnelStepResult[];
  truncated: boolean;
}

export type Outcome = 'failed' | 'abandoned';

export interface DroppedSession {
  project: string;
  id: string;
  platform: string;
  last_step_at: number;
  outcome: Outcome;
  failed_with?: string;
  /** Present from identity clearance (c4). */
  user?: string;
}

/** GET v1/funnels/{id}/steps/{step}/sessions */
export interface DroppedList {
  step: number;
  outcome?: Outcome;
  sessions: DroppedSession[];
  total: number;
  truncated: boolean;
  redacted: FieldGroup[];
}

export interface HealthRow {
  project?: string;
  platform?: string;
  sessions: number;
  errored: number;
  crashed: number;
  /** Percent of sessions with no error or crash. */
  health: number;
  crash_free: number;
}

export interface TimeSeries {
  platform: string;
  /** [ms since the epoch, value] */
  points: Array<[number, number]>;
}

export interface TopError {
  fingerprint: string;
  project: string;
  platforms: string[];
  count: number;
  sessions: number;
  fatal: boolean;
  last_seen: number;
  /** Present from attributes clearance (c2). */
  type?: string;
  message?: string;
  /** The latest session with this error. */
  session: string;
}

export interface Vital {
  platform: string;
  name: string;
  unit: string;
  p75: number;
  count: number;
}

export interface ServiceStat {
  service: string;
  rate_per_sec: number;
  error_pct: number;
  p95_ms: number | null;
}

/** GET v1/overview */
export interface Overview {
  from: number;
  to: number;
  totals: HealthRow;
  health: HealthRow[];
  step_ms: number;
  sessions_over_time: TimeSeries[];
  top_errors: TopError[];
  web_vitals: Vital[];
  mobile_vitals: Vital[];
  /** From Mimir (Tempo's span metrics); null without Mimir. */
  backend: ServiceStat[] | null;
  backend_error?: string;
  truncated: boolean;
  redacted: FieldGroup[];
}

/** Filters shared by the overview and funnels. */
export interface Scope {
  from?: number;
  to?: number;
  project?: string;
  platform?: string;
}
