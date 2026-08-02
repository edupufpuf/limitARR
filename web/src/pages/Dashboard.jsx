import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Quota from './Quota.jsx';
import Salvadas from './Salvadas.jsx';
import Libraries from './Libraries.jsx';
import Users from './Users.jsx';
import DecisionsLog from './DecisionsLog.jsx';
import Settings from './Settings.jsx';
import Notifications from './Notifications.jsx';
import WhatsNewModal from '../components/WhatsNewModal.jsx';
import { Wordmark } from '../components/Brand.jsx';
import { IconGauge, IconSave, IconFilm, IconUsers, IconClock, IconBell, IconGear, IconLogout, IconMenu, IconXCircle } from '../icons.jsx';
import { DirtyGuardProvider, useAnyDirty } from '../DirtyGuard.jsx';

const UNSAVED_WARNING = 'Hay cambios sin guardar en esta pestaña. ¿Salir igualmente?';

const TABS = {
  quota: { label: 'Cupo', Icon: IconGauge, Component: Quota },
  salvadas: { label: 'Salvadas', Icon: IconSave, Component: Salvadas },
  libraries: { label: 'Bibliotecas', Icon: IconFilm, Component: Libraries },
  users: { label: 'Usuarios', Icon: IconUsers, Component: Users },
  log: { label: 'Registro', Icon: IconClock, Component: DecisionsLog },
  notifications: { label: 'Avisos', Icon: IconBell, Component: Notifications },
  settings: { label: 'Ajustes', Icon: IconGear, Component: Settings },
};

export default function Dashboard({ onLoggedOut }) {
  return (
    <DirtyGuardProvider>
      <DashboardInner onLoggedOut={onLoggedOut} />
    </DirtyGuardProvider>
  );
}

function DashboardInner({ onLoggedOut }) {
  const [tab, setTab] = useState('quota');
  const [version, setVersion] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const { Component, label } = TABS[tab];
  const anyDirty = useAnyDirty();

  useEffect(() => {
    api.version().then(setVersion).catch(() => {});
  }, []);

  function goTab(key) {
    if (key !== tab && anyDirty() && !window.confirm(UNSAVED_WARNING)) return;
    setTab(key);
    setMenuOpen(false);
  }

  async function logout() {
    if (anyDirty() && !window.confirm(UNSAVED_WARNING)) return;
    await api.logout();
    onLoggedOut();
  }

  return (
    <div className="min-h-screen flex flex-col sm:flex-row bg-bg-950 text-gray-100">
      {/* Overlay — solo móvil, cierra el menú al tocar fuera */}
      {menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          className="sm:hidden fixed inset-0 bg-black/60 z-20 backdrop-blur-sm"
        />
      )}

      {/* Sidebar — fija en desktop, cajón deslizante escondido en móvil */}
      <nav
        className={`fixed sm:sticky inset-y-0 left-0 sm:top-0 z-30 sm:z-auto w-[280px] sm:w-[300px] h-screen overflow-y-auto bg-gradient-to-b from-bg-900 via-bg-900 to-bg-950 border-r border-bg-700/55 px-7 py-8 flex flex-col flex-shrink-0 shadow-[18px_0_48px_-32px_rgba(0,0,0,.85)] transition-transform duration-300 sm:transition-none ${
          menuOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'
        }`}
      >
        <div className="mb-16 flex items-center justify-between">
          <Wordmark className="text-[42px]" />
          <button onClick={() => setMenuOpen(false)} className="sm:hidden text-gray-400 p-1 -mr-1">
            <IconXCircle className="w-7 h-7" />
          </button>
        </div>
        <div className="space-y-4">
          {Object.entries(TABS).map(([key, { label, Icon }]) => (
            <button
              key={key}
              onClick={() => goTab(key)}
              className={`relative flex items-center gap-5 w-full text-left px-5 py-4 rounded-xl text-[24px] leading-none font-extrabold tracking-tight transition-all ${
                tab === key
                  ? 'bg-gradient-to-r from-accent-700 via-accent-600 to-accent-500 text-white shadow-glow'
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
          className="flex items-center gap-5 mt-auto text-left px-5 py-3 rounded-xl text-lg font-extrabold text-gray-400 hover:text-gray-100 hover:bg-bg-800 transition-colors"
        >
          <IconLogout className="w-7 h-7 flex-shrink-0" />
          Cerrar sesión
        </button>
        {version && (
          <div className="mt-5 rounded-xl border border-bg-600/90 bg-bg-950/45 px-5 py-5 text-base text-gray-300 shadow-card">
            <div className="flex items-center gap-4">
              <span
                className={`inline-flex w-11 h-11 rounded-lg border items-center justify-center ${
                  version.updateAvailable ? 'border-yellow-400/70 bg-yellow-400/10 text-yellow-300' : 'border-gray-500/70'
                }`}
              >
                <IconGear className="w-6 h-6" />
              </span>
              <div>
                <div className="font-extrabold text-gray-200">Limitarr</div>
                <div className="tabular-nums tracking-[0.22em] text-gray-300 text-lg">
                  {version.version}
                </div>
              </div>
            </div>
            <div className="mt-3 text-xs text-gray-500 tabular-nums">
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
        <button onClick={() => setMenuOpen(true)} className="text-gray-300 p-1 -ml-1">
          <IconMenu className="w-6 h-6" />
        </button>
        <span className="text-sm text-gray-400">{label}</span>
        <button onClick={logout} className="text-gray-400 p-1 -mr-1">
          <IconLogout className="w-5 h-5" />
        </button>
      </header>

      <main className="flex-1 p-4 sm:p-8 lg:p-10 pb-8 overflow-x-hidden">
        <Component />
      </main>

      <WhatsNewModal />
    </div>
  );
}
