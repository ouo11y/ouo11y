import type { AppPlugin, KeyValue } from '@grafana/data';
import { OverviewHealthV1, SessionDetailV1, SessionsListV1 } from './components';
import {
  EXPOSED_COMPONENT_IDS,
  type OverviewHealthV1Props,
  type SessionDetailV1Props,
  type SessionsListV1Props,
} from './types';

/**
 * Title and description of every exposed component. plugin.json `extensions.exposedComponents`
 * must list the same ids, titles and descriptions (Grafana ignores a registration plugin.json does
 * not declare); plugin.test.ts keeps the two in step.
 */
export const EXPOSED_COMPONENT_META = {
  [EXPOSED_COMPONENT_IDS.sessionDetail]: {
    title: 'ouo session detail',
    description: 'One session: header, replay player with its activity list, traces and logs.',
  },
  [EXPOSED_COMPONENT_IDS.sessionsList]: {
    title: 'ouo sessions list',
    description: 'Sessions in a time range, filtered by project, app, platform, status, version and user.',
  },
  [EXPOSED_COMPONENT_IDS.overviewHealth]: {
    title: 'ouo session health',
    description: 'Healthy, errored and crashed sessions per platform and version.',
  },
} as const;

export function registerExposedComponents<T extends KeyValue>(plugin: AppPlugin<T>): AppPlugin<T> {
  const { sessionDetail, sessionsList, overviewHealth } = EXPOSED_COMPONENT_IDS;
  return plugin
    .exposeComponent<SessionDetailV1Props>({
      id: sessionDetail,
      ...EXPOSED_COMPONENT_META[sessionDetail],
      component: SessionDetailV1,
    })
    .exposeComponent<SessionsListV1Props>({
      id: sessionsList,
      ...EXPOSED_COMPONENT_META[sessionsList],
      component: SessionsListV1,
    })
    .exposeComponent<OverviewHealthV1Props>({
      id: overviewHealth,
      ...EXPOSED_COMPONENT_META[overviewHealth],
      component: OverviewHealthV1,
    });
}
