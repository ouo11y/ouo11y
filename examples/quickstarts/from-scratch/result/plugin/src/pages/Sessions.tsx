import React, { useEffect, useState } from 'react';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, LoadingPlaceholder, TextLink } from '@grafana/ui';
import { listSessions, type Session } from '../api';
import { PLUGIN_BASE_URL } from '../constants';

const time = (ms: number) => new Date(ms).toLocaleString();
const seconds = (s: Session) => `${Math.round((s.end - s.start) / 1000)} s`;

function Sessions() {
  const [sessions, setSessions] = useState<Session[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    listSessions().then((r) => setSessions(r.sessions), (e) => setError(e?.data?.message ?? String(e)));
  }, []);

  return (
    <PluginPage>
      {error && <Alert title="Sessions could not be read">{error}</Alert>}
      {!sessions && !error && <LoadingPlaceholder text="Reading sessions from Loki" />}
      {sessions?.length === 0 && <p>No session in the last 24 hours. Open the web app of guide 01 and click around.</p>}
      {sessions && sessions.length > 0 && (
        <table className="filter-table">
          <thead>
            <tr><th>Started</th><th>Service</th><th>User</th><th>Duration</th><th>Events</th><th>Errors</th><th>Replay</th></tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td><TextLink href={`${PLUGIN_BASE_URL}/${s.project}/${s.id}`} inline={false}>{time(s.start)}</TextLink></td>
                <td>{s.service}</td>
                <td>{s.user ?? <i>hidden or anonymous</i>}</td>
                <td>{seconds(s)}</td>
                <td>{s.event_count}</td>
                <td>{s.error_count > 0 ? <Badge color="red" text={String(s.error_count)} /> : 0}</td>
                <td>{s.has_replay ? 'yes' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PluginPage>
  );
}

export default Sessions;
