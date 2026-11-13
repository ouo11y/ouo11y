import React, { useState } from 'react';
import { Button, Input, RadioButtonGroup, Stack } from '@grafana/ui';
import type { Scope } from '@ouo11y/kit';

export const RANGES = [
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
];
export const RANGE_MS: Record<string, number> = {
  '1h': 3600e3,
  '6h': 6 * 3600e3,
  '24h': 24 * 3600e3,
  '7d': 7 * 24 * 3600e3,
};

const PLATFORMS = [
  { label: 'All', value: '' },
  { label: 'Web', value: 'web' },
  { label: 'iOS', value: 'ios' },
  { label: 'Android', value: 'android' },
];

/** The window is fixed when the range is chosen, so links carry the window the page was read in. */
export function useScope(initial = '24h') {
  const [s, set] = useState(() => ({ range: initial, to: Date.now(), project: '', platform: '' }));
  const scope: Scope & { range: string } = {
    range: s.range,
    from: s.to - RANGE_MS[s.range],
    to: s.to,
    project: s.project,
    platform: s.platform,
  };
  return {
    scope,
    key: `${scope.from}/${scope.to}/${scope.project}/${scope.platform}`,
    setRange: (range: string) => set({ ...s, range, to: Date.now() }),
    refresh: () => set({ ...s, to: Date.now() }),
    setProject: (project: string) => set({ ...s, project }),
    setPlatform: (platform: string) => set({ ...s, platform }),
  };
}

export function ScopeBar({ ctl, platforms = true }: { ctl: ReturnType<typeof useScope>; platforms?: boolean }) {
  const [project, setProject] = useState(ctl.scope.project ?? '');
  return (
    <Stack gap={1} wrap="wrap" alignItems="center">
      <RadioButtonGroup options={RANGES} value={ctl.scope.range} onChange={ctl.setRange} />
      {platforms && <RadioButtonGroup options={PLATFORMS} value={ctl.scope.platform} onChange={ctl.setPlatform} />}
      <Input
        width={20}
        placeholder="All projects"
        value={project}
        onChange={(e) => setProject(e.currentTarget.value)}
        onBlur={() => ctl.setProject(project.trim())}
        onKeyDown={(e) => e.key === 'Enter' && ctl.setProject(project.trim())}
        aria-label="Project"
      />
      <Button variant="secondary" icon="sync" onClick={ctl.refresh}>
        Refresh
      </Button>
    </Stack>
  );
}
