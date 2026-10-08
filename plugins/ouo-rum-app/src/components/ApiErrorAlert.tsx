import React from 'react';
import { Alert, Button } from '@grafana/ui';
import type { RumApiError } from '../api/client';

export function ApiErrorAlert({ error, onRetry }: { error: RumApiError; onRetry?: () => void }) {
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
