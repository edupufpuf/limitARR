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
    <div className="min-h-screen flex flex-col sm:flex-row bg-bg-950 text-gray-100">
      {/* Sidebar — solo desktop */}
      <nav className="hidden sm:flex w-[292px] bg-gradient-to-b from-bg-900 via-bg-900 to-bg-950 border-r border-bg-700/55 px-5 py-6 flex-col flex-shrink-0 shadow-[18px_0_48px_-32px_rgba(0,0,0,.85)]">
        <div className="flex items-center gap-5 px-1 mb-16">
          <LogoMark className="w-20 h-20" />
          <Wordmark className="text-5xl" />
        </div>
        <div className="space-y-4">
          {Object.entries(TABS).map(([key, { label, Icon }]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`relative flex items-center gap-5 w-full text-left px-5 py-4 rounded-xl text-[22px] font-extrabold tracking-tight transition-all ${
                tab === key
                  ? 'bg-gradient-to-r from-indigo-500 via-accent-600 to-purple-600 text-white shadow-glow'
                  : 'text-gray-100/90 hover:text-white hover:bg-bg-800/70'
              }`}
            >
              <Icon className="w-8 h-8 flex-shrink-0" />
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-4 mt-auto text-left px-5 py-3 rounded-xl text-base font-semibold text-gray-400 hover:text-gray-100 hover:bg-bg-800 transition-colors"
        >
          <IconLogout className="w-6 h-6 flex-shrink-0" />
          Cerrar sesión
        </button>
        {version && (
          <div className="mt-4 rounded-xl border border-bg-600/90 bg-bg-950/45 px-5 py-4 text-sm text-gray-300 shadow-card">
            <div className="flex items-center gap-3">
              <span className="inline-flex w-9 h-9 rounded-lg border border-gray-500/70 items-center justify-center">
                <IconGear className="w-5 h-5" />
              </span>
              <div>
                <div className="font-bold text-gray-200">Limitarr</div>
                <div className="tabular-nums tracking-[0.18em] text-gray-300">
                  {version.version}
                </div>
              </div>
            </div>
            <div className="mt-3 text-[11px] text-gray-500 tabular-nums">
              {version.sha ?? 'dev'}
            </div>
            {version.updateAvailable && (
              <a
                href="https://github.com/edupufpuf/limitARR"
                target="_blank"
                rel="noreferrer"
                title={`Nueva imagen en GHCR: ${version.latestSha}`}
                className="flex items-center gap-1.5 mt-2 text-accent-300 hover:text-white"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-accent-300 animate-pulse" />
                Actualización disponible
              </a>
            )}
          </div>
        )}
      </nav>

      {/* Top bar — solo móvil */}
      <header className="sm:hidden flex items-center justify-between px-4 h-16 bg-bg-900/95 border-b border-bg-700/60 flex-shrink-0 sticky top-0 z-10 backdrop-blur">
        <div className="flex items-center gap-2">
          <LogoMark className="w-9 h-9" />
          <Wordmark className="text-xl" />
        </div>
        <span className="text-sm text-gray-400">{label}</span>
        <button onClick={logout} className="text-gray-400 p-1 -mr-1">
          <IconLogout className="w-5 h-5" />
        </button>
      </header>

      <main className="flex-1 p-4 sm:p-8 lg:p-10 pb-20 sm:pb-8 overflow-x-hidden">
        <Component />
      </main>

      {/* Barra de pestañas — solo móvil */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-bg-900/95 border-t border-bg-700/60 flex z-10 backdrop-blur">
        {Object.entries(TABS).map(([key, { label, Icon }]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] transition-colors ${
              tab === key ? 'text-accent-300' : 'text-gray-500'
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
