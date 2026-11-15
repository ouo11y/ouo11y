import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Alert, LoadingPlaceholder } from '@grafana/ui';
import { ReplayPlayer, type Manifest } from '@ouo11y/kit';
import { getChunk, getManifest, getSession, type Event, type Replay, type Session as S } from '../api';

// What one event says, in a few words. Loki writes attribute names with `_` for `.`; the web
// SDK and the mobile SDK name a few things differently (url_full, url_path).
function summary(e: Event) {
  const a = e.attributes ?? {};
  const body = e.body !== e.name ? e.body : undefined; // mobile events repeat their name as body
  return a.exception_message || a.product_name || a.url_path || a.url_full || a.browser_web_vital_name || a.browser_css_selector || body || '';
}

function Session() {
  const { project = '', session = '' } = useParams();
  const [data, setData] = useState<{ session: S; events: Event[]; replays: Replay[] }>();
  const [manifest, setManifest] = useState<Manifest>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    getSession(project, session).then(async (d) => {
      setData(d);
      const replay = d.replays[0];
      if (replay) {
        setManifest(await getManifest(project, session, replay.replay_id));
      }
    }, (e) => setError(e?.data?.message ?? String(e)));
  }, [project, session]);

  const s = data?.session;
  return (
    <PluginPage pageNav={{ text: `Session ${session.slice(0, 8)}` }}>
      {error && <Alert title="Session could not be read">{error}</Alert>}
      {!data && !error && <LoadingPlaceholder text="Reading the session" />}
      {s && (
        <p>
          {s.service}, user {s.user ?? <i>hidden or anonymous</i>}, {new Date(s.start).toLocaleString()},{' '}
          {data.events.length} events
        </p>
      )}
      {manifest && (
        <ReplayPlayer
          key={manifest.replay_id}
          manifest={manifest}
          fetchChunk={(stream, seq) => getChunk(project, session, manifest.replay_id, stream, seq)}
        />
      )}
      {data && data.replays.length === 0 && <p>This session has no replay.</p>}
      {data && (
        <table className="filter-table">
          <thead>
            <tr><th>Time</th><th>Event</th><th>What</th></tr>
          </thead>
          <tbody>
            {data.events.map((e, i) => (
              <tr key={i}>
                <td>{new Date(e.time).toLocaleTimeString()}</td>
                <td>{e.severity === 'ERROR' ? <b>{e.name}</b> : e.name}</td>
                <td>{summary(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PluginPage>
  );
}

export default Session;
