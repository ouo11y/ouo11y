/**
 * The props contract of ouo's exposed components (ADR-0019). Host plugins copy these types (or
 * the ones in docs/embedding.md) and pass them to the component `usePluginComponent` returns.
 *
 * Stability rule for every `/v1` id: props may be added (optional, with a default that keeps the
 * old behaviour) but never removed, renamed, retyped or given a new meaning. Anything else ships
 * as a `/v2` id next to `/v1`.
 */

/** Ids of the exposed components: `<plugin id>/<component>/<major version>`. */
export const EXPOSED_COMPONENT_IDS = {
  sessionDetail: 'ouo11y-rum-app/session-detail/v1',
  sessionsList: 'ouo11y-rum-app/sessions-list/v1',
  overviewHealth: 'ouo11y-rum-app/overview-health/v1',
} as const;

/**
 * A time range as Grafana writes it in a URL: relative (`now-6h`, `now`) or absolute (an ISO 8601
 * string or epoch milliseconds). From a Grafana `TimeRange`, pass `range.raw` when it holds strings,
 * else `{ from: range.from.valueOf(), to: range.to.valueOf() }`.
 */
export interface EmbedTimeRange {
  from: string | number;
  to: string | number;
}

/** Props every exposed component takes. All optional. */
export interface EmbedScopeProps {
  /** Default: the last 24 hours (`now-24h` to `now`), as on ouo's own pages. */
  timeRange?: EmbedTimeRange;
  /** ouo project id (`ouo.project.id`). Empty or absent: every project. */
  project?: string;
  /** App (`service.name`) inside the project. Empty or absent: every app. */
  app?: string;
}

/** `ouo11y-rum-app/session-detail/v1`: header, replay player with its activity list, traces, logs. */
export interface SessionDetailV1Props extends EmbedScopeProps {
  /** The session to show. Required. */
  sessionId: string;
}

export type SessionPlatform = 'web' | 'mobile';
export type SessionStatus = 'healthy' | 'errored' | 'crashed';

/** Filters of the sessions list; each one narrows the list, absent means any. */
export interface SessionsListFilters {
  platform?: SessionPlatform;
  status?: SessionStatus;
  /** Exact `service.version`. */
  version?: string;
  /** Exact user id (`user.id`). */
  user?: string;
}

/** `ouo11y-rum-app/sessions-list/v1`: the sortable sessions table, newest first. */
export interface SessionsListV1Props extends EmbedScopeProps {
  filters?: SessionsListFilters;
  /** Most sessions to load, 1 to 1000. Default 100. */
  limit?: number;
  /**
   * Called with the session id when a row is clicked. Default: open the session in ouo's own
   * Session page (link out), keeping the time range and scope.
   */
  onSessionClick?: (sessionId: string) => void;
}

/** `ouo11y-rum-app/overview-health/v1`: healthy / errored / crashed tiles and the version table per platform. */
export interface OverviewHealthV1Props extends EmbedScopeProps {}
