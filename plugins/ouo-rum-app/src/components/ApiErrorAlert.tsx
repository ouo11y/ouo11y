import React from 'react';
import { Alert, Button, LinkButton, Stack } from '@grafana/ui';
import type { RumApiError } from '../api/client';
import { PLUGIN_CONFIG_URL } from '../constants';

/**
 * One banner for a failed rum-api call. A 401 gets its own wording: the request reached rum-api
 * but the read token Grafana adds server-side (secureJsonData.readToken) was missing or wrong.
 */
export function ApiErrorAlert({ error, onRetry }: { error: RumApiError; onRetry?: () => void }) {
  if (error.unauthorized) {
    return (
      <Alert severity="warning" title="rum-api rejected the read token" data-testid="read-token-alert">
        <div>
          Grafana forwards every request to rum-api with the read token stored in the plugin settings. rum-api answered{' '}
          <code>401</code>, so the token is missing or does not match the <code>OUO_READ_TOKEN</code> rum-api was
          started with. Configure it in the plugin settings (Administration &gt; Plugins &gt; ouo RUM &gt;
          Configuration) and use &quot;Test connection&quot; there.
        </div>
        <div style={{ marginTop: 4, opacity: 0.8, wordBreak: 'break-all' }}>
          <code>GET {error.url}</code>
        </div>
        <Stack gap={1} alignItems="center">
          <LinkButton size="sm" variant="primary" icon="cog" href={PLUGIN_CONFIG_URL}>
            Open plugin settings
          </LinkButton>
          {onRetry && (
            <Button size="sm" variant="secondary" icon="sync" onClick={onRetry}>
              Retry
            </Button>
          )}
        </Stack>
      </Alert>
    );
  }
  return (
    <Alert severity="error" title="rum-api request failed">
      <div>{error.message}</div>
      <div style={{ marginTop: 4, opacity: 0.8, wordBreak: 'break-all' }}>
        <code>GET {error.url}</code>
      </div>
      <div style={{ marginTop: 4, opacity: 0.8 }}>
        Grafana proxies this path to the rum-api URL set in the plugin configuration (default{' '}
        <code>http://rum-api:8080</code>).
      </div>
      {onRetry && (
        <div style={{ marginTop: 8 }}>
          <Button size="sm" variant="secondary" icon="sync" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </Alert>
  );
}
