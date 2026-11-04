import React from 'react';
import { PluginPage, type PluginPageProps } from '@grafana/runtime';
import { useEmbed } from '../embed/EmbedContext';

/**
 * `PluginPage` on ouo's own routes. Embedded in a host plugin (ADR-0019) the host owns the page
 * chrome (title, breadcrumbs, actions), so only the content renders: a second `PluginPage` would
 * draw a second page header inside the host's page, and the actions (time picker, scope picker,
 * back links) write ouo's URL query, which the host's URL does not carry.
 */
export function PageShell(props: PluginPageProps) {
  const embed = useEmbed();
  if (embed) {
    return <div data-testid="ouo-embedded-page">{props.children}</div>;
  }
  return <PluginPage {...props} />;
}
