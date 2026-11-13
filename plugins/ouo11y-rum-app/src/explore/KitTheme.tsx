import React, { type ReactNode } from 'react';
import { useTheme2 } from '@grafana/ui';
import { themeStyle } from '@ouo11y/kit';

/** Maps Grafana's theme onto the kit's CSS custom properties (the only Grafana wiring the kit needs). */
export function KitTheme({ children }: { children: ReactNode }) {
  const t = useTheme2();
  return (
    <div
      style={themeStyle({
        border: t.colors.border.weak,
        muted: t.colors.text.secondary,
        hover: t.colors.action.hover,
        accent: t.colors.primary.main,
        danger: t.colors.error.main,
        warning: t.colors.warning.main,
        track: t.colors.background.secondary,
      })}
    >
      {children}
    </div>
  );
}
