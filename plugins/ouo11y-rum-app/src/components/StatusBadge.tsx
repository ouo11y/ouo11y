import React from 'react';
import { Badge, type BadgeColor } from '@grafana/ui';
import type { IconName } from '@grafana/data';

const STATUS: Record<string, { color: BadgeColor; icon: IconName }> = {
  healthy: { color: 'green', icon: 'check-circle' },
  errored: { color: 'orange', icon: 'exclamation-triangle' },
  crashed: { color: 'red', icon: 'bug' },
};

export function StatusBadge({ status }: { status: string }) {
  const def = STATUS[status] ?? { color: 'darkgrey' as BadgeColor, icon: 'question-circle' as IconName };
  return <Badge text={status} color={def.color} icon={def.icon} />;
}

export function StateBadge({ state, endReason }: { state: string; endReason: string | null }) {
  if (state === 'active') {
    return <Badge text="active" color="blue" icon="sync" />;
  }
  return <Badge text={endReason ? `ended · ${endReason}` : 'ended'} color="darkgrey" icon="check" />;
}
