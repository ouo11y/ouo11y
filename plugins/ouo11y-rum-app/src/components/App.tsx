import React, { useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { type AppRootProps } from '@grafana/data';
import { ROUTES } from '../constants';
import { FeatureTogglesContext, parseFeatureToggles } from '../featureToggles';
import type { AppSettings } from './AppConfig';

const Overview = React.lazy(() => import('../pages/Overview'));
const Sessions = React.lazy(() => import('../pages/Sessions'));
const SessionDetail = React.lazy(() => import('../pages/SessionDetail'));
const Funnels = React.lazy(() => import('../pages/Funnels'));

export default function App({ meta }: AppRootProps<AppSettings>) {
  const toggles = useMemo(() => parseFeatureToggles(meta?.jsonData?.featureToggles), [meta?.jsonData?.featureToggles]);
  return (
    <FeatureTogglesContext.Provider value={toggles}>
      <Routes>
        <Route path={ROUTES.Overview} element={<Overview />} />
        <Route path={ROUTES.Sessions} element={<Sessions />} />
        <Route path={`${ROUTES.Sessions}/:id`} element={<SessionDetail />} />
        <Route path={ROUTES.Funnels} element={<Funnels />} />
        <Route path="*" element={<Navigate to={ROUTES.Overview} replace />} />
      </Routes>
    </FeatureTogglesContext.Provider>
  );
}
