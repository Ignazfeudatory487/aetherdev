import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store/index.ts';
import Layout from './components/Layout.tsx';
import ChatPage from './pages/ChatPage.tsx';
import PipelinePage from './pages/PipelinePage.tsx';
import ReviewPage from './pages/ReviewPage.tsx';
import PluginsPage from './pages/PluginsPage.tsx';
import SettingsPage from './pages/SettingsPage.tsx';
import DashboardPage from './pages/DashboardPage.tsx';
import { useEngineStatus } from './hooks/useApi.ts';

export default function App() {
  const { setEngineStatus } = useStore();
  const { data: status } = useEngineStatus();

  useEffect(() => {
    if (status) setEngineStatus(status);
  }, [status, setEngineStatus]);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/pipeline" element={<PipelinePage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
