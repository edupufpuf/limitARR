import { useState } from 'react';
import { api } from '../api.js';
import Quota from './Quota.jsx';
import Libraries from './Libraries.jsx';
import Overrides from './Overrides.jsx';
import DecisionsLog from './DecisionsLog.jsx';
import Settings from './Settings.jsx';
import Notifications from './Notifications.jsx';

const TABS = {
  quota: { label: 'Cupo', Component: Quota },
  libraries: { label: 'Bibliotecas', Component: Libraries },
  overrides: { label: 'Overrides', Component: Overrides },
  log: { label: 'Registro', Component: DecisionsLog },
  notifications: { label: 'Notificaciones', Component: Notifications },
  settings: { label: 'Configuración', Component: Settings },
};

export default function Dashboard({ onLoggedOut }) {
  const [tab, setTab] = useState('quota');
  const { Component } = TABS[tab];

  async function logout() {
    await api.logout();
    onLoggedOut();
  }

  return (
    <div className="min-h-screen flex">
      <nav className="w-56 bg-bg-800 border-r border-bg-700 p-4 flex flex-col">
        <h1 className="text-xl font-bold text-accent-500 mb-8">limitARR</h1>
        {Object.entries(TABS).map(([key, { label }]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`text-left px-3 py-2 rounded mb-1 text-sm font-medium ${
              tab === key ? 'bg-accent-600 text-white' : 'text-gray-300 hover:bg-bg-700'
            }`}
          >
            {label}
          </button>
        ))}
        <button onClick={logout} className="mt-auto text-left px-3 py-2 rounded text-sm text-gray-500 hover:bg-bg-700">
          Cerrar sesión
        </button>
      </nav>
      <main className="flex-1 p-8">
        <Component />
      </main>
    </div>
  );
}
