import React from 'react';
import { render, screen } from '@testing-library/react';
import { RumApiError } from '../api/client';
import { ApiErrorAlert } from './ApiErrorAlert';

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: jest.fn() }),
  isFetchError: () => false,
}));

describe('ApiErrorAlert', () => {
  it('renders the read token banner with a link to the plugin settings on 401', () => {
    render(<ApiErrorAlert error={new RumApiError('HTTP 401: rum-api rejected the read token', '/api/x', 401)} />);
    expect(screen.getByTestId('read-token-alert')).toBeInTheDocument();
    expect(screen.getByText('rum-api rejected the read token')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open plugin settings/i })).toHaveAttribute('href', '/plugins/ouo11y-rum-app');
    expect(screen.queryByText('rum-api request failed')).not.toBeInTheDocument();
  });

  it('renders the generic error for other statuses', () => {
    render(<ApiErrorAlert error={new RumApiError('HTTP 502: bad gateway', '/api/x', 502)} onRetry={jest.fn()} />);
    expect(screen.getByText('rum-api request failed')).toBeInTheDocument();
    expect(screen.queryByTestId('read-token-alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
