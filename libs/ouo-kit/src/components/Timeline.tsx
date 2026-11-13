import React, { useState } from 'react';
import type { Event } from '../api';
import { formatDuration } from '../format';
import { cell, table, themeVars } from './theme';

export interface TimelineProps {
  events: Event[];
  /** Session start, ms since the epoch: times show as +offset. */
  start: number;
  /** Called with the clicked event (seek a replay there, for example). */
  onSelect?: (e: Event, index: number) => void;
}

/**
 * A session's event timeline. A click opens the event's attributes and body when the caller's
 * clearance carried them (c2 and up); at c1 the rows are time, name and severity only.
 */
export function Timeline({ events, start, onSelect }: TimelineProps) {
  const [open, setOpen] = useState<number>();
  return (
    <table style={table}>
      <tbody>
        {events.map((e, i) => {
          const detail = Boolean(e.attributes && Object.keys(e.attributes).length) || Boolean(e.body);
          return (
            <React.Fragment key={i}>
              <tr
                data-testid="timeline-event"
                style={{ cursor: detail || onSelect ? 'pointer' : undefined }}
                onClick={() => {
                  setOpen(open === i ? undefined : i);
                  onSelect?.(e, i);
                }}
              >
                <td style={{ ...cell, color: themeVars.muted, whiteSpace: 'nowrap' }}>+{formatDuration(e.time - start)}</td>
                <td style={cell}>{e.name}</td>
                <td style={{ ...cell, color: themeVars.danger }}>{e.severity && e.severity !== 'INFO' ? e.severity : ''}</td>
              </tr>
              {open === i && detail && (
                <tr>
                  <td colSpan={3} style={cell}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.85em' }}>
                      {Object.entries(e.attributes ?? {})
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([k, v]) => `${k}: ${v}`)
                        .join('\n')}
                      {e.body ? `\n\n${e.body}` : ''}
                    </pre>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
