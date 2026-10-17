import React from 'react';
import { Icon, Tooltip } from '@grafana/ui';

export function PlatformIcon({ platform }: { platform: string }) {
  const name = platform === 'mobile' ? 'mobile-android' : 'globe';
  return (
    <Tooltip content={platform}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Icon name={name} /> {platform}
      </span>
    </Tooltip>
  );
}
