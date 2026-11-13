import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, Button, EmptyState, LoadingPlaceholder, RadioButtonGroup, Stack } from '@grafana/ui';
import { SessionTable } from '@ouo11y/kit';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { bff, useBff } from './bff';
import { ClearanceNote } from './ClearanceNote';
import { KitTheme } from './KitTheme';
import { RANGE_MS, RANGES } from './ScopeBar';

export function sessionHref(project: string, id: string, from: number, to: number): string {
  return `${PLUGIN_BASE_URL}/${ROUTES.Explore}/${project}/${id}?from=${from}&to=${to}`;
}

/** Session explorer: the sessions with records in the range, newest first, from the BFF. */
export default function ExploreSessions() {
  // The window is fixed when the range is chosen, so links carry the window the list was read in.
  const [{ range, to }, setWindow] = useState(() => ({ range: '24h', to: Date.now() }));
  const from = to - RANGE_MS[range];
  const me = useBff(() => bff.me(), 'me');
  const list = useBff(() => bff.sessions(from, to), `${from}`);

  return (
    <PluginPage>
      <Stack direction="column" gap={2}>
        <Stack justifyContent="space-between" alignItems="center">
          <Stack gap={1}>
            <RadioButtonGroup
              options={RANGES}
              value={range}
              onChange={(v) => setWindow({ range: v, to: Date.now() })}
            />
            <Button variant="secondary" icon="sync" onClick={() => setWindow({ range, to: Date.now() })}>
              Refresh
            </Button>
          </Stack>
          {me.data && <Badge color="blue" text={`Clearance c${me.data.level}`} />}
        </Stack>
        <ClearanceNote me={me.data} redacted={list.data?.redacted} />
        {list.error && (
          <Alert severity="error" title="Sessions could not be read">
            {list.error.message}
          </Alert>
        )}
        {list.loading && !list.data && <LoadingPlaceholder text="Loading sessions…" />}
        {list.data?.truncated && (
          <Alert severity="warning" title="Partial list">
            The range holds more records than one read covers; older sessions may be missing. Narrow the range.
          </Alert>
        )}
        {list.data && list.data.sessions.length === 0 && (
          <EmptyState variant="not-found" message="No sessions in this range" />
        )}
        {list.data && list.data.sessions.length > 0 && (
          <KitTheme>
            <SessionTable
              sessions={list.data.sessions}
              canSeeUsers={me.data?.can.identity}
              link={(s, children) => (
                <Link to={sessionHref(s.project, s.id, from, to)} data-testid="session-link">
                  {children}
                </Link>
              )}
            />
          </KitTheme>
        )}
      </Stack>
    </PluginPage>
  );
}
