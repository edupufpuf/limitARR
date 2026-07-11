import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Quota from './Quota.jsx';
import Libraries from './Libraries.jsx';
import Overrides from './Overrides.jsx';
import DecisionsLog from './DecisionsLog.jsx';
import Settings from './Settings.jsx';
import Notifications from './Notifications.jsx';
import { LogoMark, Wordmark } from '../components/Brand.jsx';
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
  const [version, setVersion] = useState(null);
  const { Component, label } = TABS[tab];

  useEffect(() => {
    api.version().then(setVersion).catch(() => {});
  }, []);

  async function logout() {
    await api.logout();
    onLoggedOut();
  }

  return (
    <div className="min-h-screen flex flex-col sm:flex-row">
      {/* Sidebar — solo desktop */}
      <nav className="hidden sm:flex w-60 bg-bg-900/80 border-r border-bg-700/60 p-4 flex-col flex-shrink-0 backdrop-blur">
        <div className="flex items-center gap-2.5 px-1 mb-8">
          <LogoMark />
          <Wordmark />
        </div>
        {Object.entries(TABS).map(([key, { label, Icon }]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`relative flex items-center gap-2.5 text-left px-3 py-2 rounded-lg mb-1 text-sm font-medium transition-all ${
              tab === key
                ? 'bg-gradient-to-r from-accent-600 to-accent-500 text-white shadow-glow'
                : 'text-gray-400 hover:text-gray-200 hover:bg-bg-800'
            }`}
          >
            <Icon className="w-5 h-5 flex-shrink-0" />
            {label}
          </button>
        ))}
        <button
          onClick={logout}
          className="flex items-center gap-2.5 mt-auto text-left px-3 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300 hover:bg-bg-800 transition-colors"
        >
          <IconLogout className="w-5 h-5 flex-shrink-0" />
          Cerrar sesión
        </button>
        {version && (
          <div className="px-3 pt-3 mt-2 border-t border-bg-700/60 text-[11px] text-gray-600">
            <span className="tabular-nums">
              v{version.version} · {version.sha ?? 'dev'}
            </span>
            {version.updateAvailable && (
              <a
                href="https://github.com/edupufpuf/limitARR"
                target="_blank"
                rel="noreferrer"
                title={`Nueva imagen en GHCR: ${version.latestSha}`}
                className="flex items-center gap-1.5 mt-1 text-accent-400 hover:text-accent-300"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-accent-400 animate-pulse" />
                Actualización disponible
              </a>
            )}
          </div>
        )}
      </nav>

      {/* Top bar — solo móvil */}
      <header className="sm:hidden flex items-center justify-between px-4 h-14 bg-bg-900/90 border-b border-bg-700/60 flex-shrink-0 sticky top-0 z-10 backdrop-blur">
        <div className="flex items-center gap-2">
          <LogoMark className="w-7 h-7" />
          <Wordmark className="text-base" />
        </div>
        <span className="text-sm text-gray-400">{label}</span>
        <button onClick={logout} className="text-gray-400 p-1 -mr-1">
          <IconLogout className="w-5 h-5" />
        </button>
      </header>

      <main className="flex-1 p-4 sm:p-8 pb-20 sm:pb-8 overflow-x-hidden">
        <Component />
      </main>

      {/* Barra de pestañas — solo móvil */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-bg-900/95 border-t border-bg-700/60 flex z-10 backdrop-blur">
        {Object.entries(TABS).map(([key, { label, Icon }]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] transition-colors ${
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
