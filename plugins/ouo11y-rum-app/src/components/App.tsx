import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { type AppRootProps } from '@grafana/data';
import { ROUTES } from '../constants';

const Overview = React.lazy(() => import('../pages/Overview'));
const Sessions = React.lazy(() => import('../pages/Sessions'));
const SessionDetail = React.lazy(() => import('../pages/SessionDetail'));

export default function App(_props: AppRootProps) {
  return (
    <Routes>
      <Route path={ROUTES.Overview} element={<Overview />} />
      <Route path={ROUTES.Sessions} element={<Sessions />} />
      <Route path={`${ROUTES.Sessions}/:id`} element={<SessionDetail />} />
      <Route path="*" element={<Navigate to={ROUTES.Overview} replace />} />
    </Routes>
  );
}
