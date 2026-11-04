import { rumGet } from './client';
import type { VitalRating } from './types';

/** The Long Animation Frame script seen most often in a group's slow interactions. */
export interface InteractionScript {
  invoker?: string;
  invoker_type?: string;
  file?: string;
  function?: string;
  count: number;
}

/** One row of GET /v1/vitals/inp/targets: the INP of one element on one page. */
export interface InteractionGroup {
  /** Selector of the element (the click events' `app.widget.id`); empty when none was sent. */
  target: string;
  /** Route template (`app.screen.name`) when the app sets one, else the URL path. */
  page: string;
  interaction_type?: string;
  count: number;
  sessions: number;
  p75_ms: number;
  max_ms: number;
  rating: VitalRating;
  input_delay_p75_ms: number | null;
  processing_duration_p75_ms: number | null;
  presentation_delay_p75_ms: number | null;
  script: InteractionScript | null;
}

export interface InteractionGroupsResponse {
  groups: InteractionGroup[];
  total: number;
  page_views: number;
  from: string;
  to: string;
}

export interface InteractionQuery {
  from: string;
  to: string;
  service?: string;
  environment?: string;
  release?: string;
  platform?: string;
  project?: string;
  page?: string;
  limit?: number;
}

/** p75 INP by element and page, slowest first (docs/specs/web-vitals.md). */
export function slowestInteractions(q: InteractionQuery): Promise<InteractionGroupsResponse> {
  return rumGet<InteractionGroupsResponse>('/v1/vitals/inp/targets', { ...q });
}
