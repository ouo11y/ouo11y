import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';

const Sessions = React.lazy(() => import('../../pages/Sessions'));
const Session = React.lazy(() => import('../../pages/Session'));

function App(_props: AppRootProps) {
  return (
    <Routes>
      <Route path=":project/:session" element={<Session />} />
      <Route path="*" element={<Sessions />} />
    </Routes>
  );
}

export default App;
