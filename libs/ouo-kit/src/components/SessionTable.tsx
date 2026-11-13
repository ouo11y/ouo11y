import React, { type ReactNode } from 'react';
import type { Session } from '../api';
import { formatDuration, formatTime } from '../format';
import { cell, head, table, themeVars } from './theme';

export interface SessionTableProps {
  sessions: Session[];
  /** Renders the link to one session around its label (a router Link in a host app); a plain anchor by default. */
  link?: (s: Session, label: string) => ReactNode;
  /** href for the default anchor. */
  href?: (s: Session) => string;
  /** The caller may see users (identity clearance): an empty user cell then means "no user". */
  canSeeUsers?: boolean;
}

/** The session list: last seen, project, service, duration, events, errors, replay hint, user. */
export function SessionTable({ sessions, link, href, canSeeUsers }: SessionTableProps) {
  const open = (s: Session, children: string) =>
    link ? link(s, children) : <a href={href?.(s) ?? '#'} data-testid="session-link">{children}</a>;
  return (
    <table style={table} data-testid="explore-sessions">
      <thead>
        <tr>
          {['Last seen', 'Project', 'Service', 'Duration', 'Events', 'Errors', 'Replay', 'User'].map((h) => (
            <th key={h} style={head}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={`${s.project}/${s.id}`}>
            <td style={cell}>{open(s, formatTime(s.end))}</td>
            <td style={cell}>{s.project}</td>
            <td style={cell}>{s.service}</td>
            <td style={cell}>{formatDuration(s.end - s.start)}</td>
            <td style={cell}>{s.event_count}</td>
            <td style={{ ...cell, color: s.error_count > 0 ? themeVars.danger : undefined }}>{s.error_count}</td>
            <td style={cell}>{s.has_replay ? 'yes' : ''}</td>
            <td style={cell}>{s.user ?? (canSeeUsers ? '' : <span style={{ color: themeVars.muted, fontStyle: 'italic' }}>hidden</span>)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
