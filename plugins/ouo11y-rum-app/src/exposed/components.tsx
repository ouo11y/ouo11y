import React, { lazy } from 'react';
import { Alert } from '@grafana/ui';
import { EmbedRoot, embedSearch } from './EmbedRoot';
import type { OverviewHealthV1Props, SessionDetailV1Props, SessionsListV1Props } from './types';

// The pages load on first render, so a host that never mounts a component never downloads it
// and module.js stays small (Grafana loads it for every host page that asks for a component).
const SessionDetailPage = lazy(() => import('../pages/SessionDetail'));
const OverviewPage = lazy(() => import('../pages/Overview'));
const SessionsList = lazy(() => import('./SessionsList'));

/** `ouo11y-rum-app/session-detail/v1`. */
export function SessionDetailV1(props: SessionDetailV1Props) {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
  if (!sessionId) {
    return (
      <Alert severity="error" title="ouo session detail: no session" data-testid="ouo-embed-missing-session">
        The <code>sessionId</code> prop is required.
      </Alert>
    );
  }
  return (
    <EmbedRoot search={embedSearch(props)}>
      <SessionDetailPage sessionId={sessionId} />
    </EmbedRoot>
  );
}

/** `ouo11y-rum-app/sessions-list/v1`. */
export function SessionsListV1(props: SessionsListV1Props) {
  return (
    <EmbedRoot search={embedSearch(props)}>
      <SessionsList filters={props.filters} limit={props.limit} onSessionClick={props.onSessionClick} />
    </EmbedRoot>
  );
}

/** `ouo11y-rum-app/overview-health/v1`. */
export function OverviewHealthV1(props: OverviewHealthV1Props) {
  return (
    <EmbedRoot search={embedSearch(props)}>
      <OverviewPage />
    </EmbedRoot>
  );
}
