import { useEffect, useState } from 'react';
import { api } from './api.js';
import Setup from './pages/Setup.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import UserDashboard from './pages/UserDashboard.jsx';

export default function App() {
  const [status, setStatus] = useState(null); // { authed, needsSetup }

  function refresh() {
    api.me().then(setStatus).catch(() => setStatus({ authed: false, needsSetup: false }));
  }

  useEffect(refresh, []);

  if (status === null) return null;

  if (status.needsSetup) return <Setup onDone={refresh} />;

  return status.authed ? (
    status.role === 'user'
      ? <UserDashboard session={status.user} impersonating={status.impersonating} onLoggedOut={refresh} />
      : <Dashboard onLoggedOut={refresh} />
  ) : (
    <Login onLoggedIn={refresh} />
  );
}
