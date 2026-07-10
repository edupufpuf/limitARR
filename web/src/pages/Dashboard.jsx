import { useState } from 'react';
import { api } from '../api.js';
import Quota from './Quota.jsx';
import Libraries from './Libraries.jsx';
import Overrides from './Overrides.jsx';
import DecisionsLog from './DecisionsLog.jsx';
import Settings from './Settings.jsx';
import Notifications from './Notifications.jsx';
import { IconGauge, IconFilm, IconSliders, IconClock, IconBell, IconGear, IconLogout } from '../icons.jsx';

const TABS = {
  quota: { label: 'Cupo', Icon: IconGauge, Component: Quota },
  libraries: { label: 'Bibliotecas', Icon: IconFilm, Component: Libraries },
  overrides: { label: 'Overrides', Icon: IconSliders, Component: Overrides },
  log: { label: 'Registro', Icon: IconClock, Component: DecisionsLog },
  notifications: { label: 'Avisos', Icon: IconBell, Component: Notifications },
  settings: { label: 'Ajustes', Icon: IconGear, Component: Settings },
};

export default function Dashboard({ onLoggedOut }) {
  const [tab, setTab] = useState('quota');
  const { Component, label } = TABS[tab];

  async function logout() {
    await api.logout();
    onLoggedOut();
  }

  return (
    <div className="min-h-screen flex flex-col sm:flex-row">
      {/* Sidebar — solo desktop */}
      <nav className="hidden sm:flex w-56 bg-bg-800 border-r border-bg-700 p-4 flex-col flex-shrink-0">
        <h1 className="text-xl font-bold text-accent-500 mb-8">limitARR</h1>
        {Object.entries(TABS).map(([key, { label, Icon }]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2.5 text-left px-3 py-2 rounded mb-1 text-sm font-medium ${
              tab === key ? 'bg-accent-600 text-white' : 'text-gray-300 hover:bg-bg-700'
            }`}
          >
            <Icon className="w-5 h-5 flex-shrink-0" />
            {label}
          </button>
        ))}
        <button
          onClick={logout}
          className="flex items-center gap-2.5 mt-auto text-left px-3 py-2 rounded text-sm text-gray-500 hover:bg-bg-700"
        >
          <IconLogout className="w-5 h-5 flex-shrink-0" />
          Cerrar sesión
        </button>
      </nav>

      {/* Top bar — solo móvil */}
      <header className="sm:hidden flex items-center justify-between px-4 h-14 bg-bg-800 border-b border-bg-700 flex-shrink-0 sticky top-0 z-10">
        <span className="text-lg font-bold text-accent-500">limitARR</span>
        <span className="text-sm text-gray-400">{label}</span>
        <button onClick={logout} className="text-gray-400 p-1 -mr-1">
          <IconLogout className="w-5 h-5" />
        </button>
      </header>

      <main className="flex-1 p-4 sm:p-8 pb-20 sm:pb-8 overflow-x-hidden">
        <Component />
      </main>

      {/* Barra de pestañas — solo móvil */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-bg-800 border-t border-bg-700 flex z-10">
        {Object.entries(TABS).map(([key, { label, Icon }]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] ${
              tab === key ? 'text-accent-400' : 'text-gray-500'
            }`}
          >
            <Icon className="w-5 h-5" />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
