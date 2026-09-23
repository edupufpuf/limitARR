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
import { IconGauge, IconSave, IconFilm, IconUsers, IconClock, IconBell, IconGear, IconLogout, IconMenu, IconXCircle, IconBan } from '../icons.jsx';
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

// La pestaña activa se guarda en el hash de la URL (#registro, #cupo...) para
// que un refresco de página (F5) se quede en la misma pestaña en vez de
// volver siempre a "Cupo".
function tabFromHash() {
  const key = window.location.hash.slice(1);
  return TABS[key] ? key : 'quota';
}

function DashboardInner({ onLoggedOut }) {
  const [tab, setTab] = useState(tabFromHash);
  const [version, setVersion] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const { Component, label } = TABS[tab];
  const anyDirty = useAnyDirty();

  useEffect(() => {
    api.version().then(setVersion).catch(() => {});
    api.pause().then((r) => setPaused(r.enabled)).catch(() => {});
  }, []);

  async function togglePause() {
    const next = !paused;
    if (next && !window.confirm('¿Pausar TODAS las solicitudes nuevas? Nadie podrá descargar nada hasta que lo reactives — lo que ya esté pendiente se queda en espera.')) return;
    setPauseBusy(true);
    try {
      const r = await api.setPause(next);
      setPaused(r.enabled);
    } finally {
      setPauseBusy(false);
    }
  }

  function goTab(key) {
    if (key !== tab && anyDirty() && !window.confirm(UNSAVED_WARNING)) return;
    setTab(key);
    // replaceState (no pushState): cambiar de pestaña no debe crear una
    // entrada de historial — el botón "atrás" del navegador no es para esto.
    window.history.replaceState(null, '', `#${key}`);
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
        className={`fixed sm:sticky inset-y-0 left-0 sm:top-0 z-30 sm:z-auto w-[240px] sm:w-[220px] h-screen overflow-y-auto bg-gradient-to-b from-bg-900 via-bg-900 to-bg-950 border-r border-bg-700/55 px-4 py-6 flex flex-col flex-shrink-0 shadow-[18px_0_48px_-32px_rgba(0,0,0,.85)] transition-transform duration-300 sm:transition-none ${
          menuOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'
        }`}
      >
        <div className="mb-8 flex items-center justify-between">
          <Wordmark className="text-[30px]" />
          <button onClick={() => setMenuOpen(false)} className="sm:hidden text-gray-400 p-1 -mr-1">
            <IconXCircle className="w-6 h-6" />
          </button>
        </div>
        <button
          onClick={togglePause}
          disabled={pauseBusy}
          title="Mientras está activo, ninguna solicitud nueva se aprueba: se queda en espera hasta que lo reactives."
          className={`flex items-center gap-2 w-full mb-5 px-3 py-2 rounded-lg text-xs font-bold text-left transition-colors border ${
            paused
              ? 'bg-accent-600/20 border-accent-500 text-accent-300 animate-pulse'
              : 'bg-bg-800/60 border-bg-600 text-gray-300 hover:text-white hover:bg-bg-800'
          }`}
        >
          <IconBan className="w-4 h-4 flex-shrink-0" />
          {paused ? 'Pausa global ACTIVA — tocar para reanudar' : 'Pausar todas las solicitudes'}
        </button>

        <div className="space-y-1">
          {Object.entries(TABS).map(([key, { label, Icon }]) => (
            <button
              key={key}
              onClick={() => goTab(key)}
              className={`relative flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-lg text-base leading-none font-bold tracking-tight transition-all ${
                tab === key
                  ? 'bg-gradient-to-r from-accent-700 via-accent-600 to-accent-500 text-white shadow-glow'
                  : 'text-gray-100/90 hover:text-white hover:bg-bg-800/70'
              }`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-3 mt-auto text-left px-3 py-2 rounded-lg text-sm font-bold text-gray-400 hover:text-gray-100 hover:bg-bg-800 transition-colors"
        >
          <IconLogout className="w-5 h-5 flex-shrink-0" />
          Cerrar sesión
        </button>
        {version && (
          <div className="mt-3 rounded-lg border border-bg-600/90 bg-bg-950/45 px-3 py-3 text-sm text-gray-300 shadow-card">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex w-8 h-8 rounded-md border items-center justify-center ${
                  version.updateAvailable ? 'border-yellow-400/70 bg-yellow-400/10 text-yellow-300' : 'border-gray-500/70'
                }`}
              >
                <IconGear className="w-4 h-4" />
              </span>
              <div>
                <div className="font-extrabold text-gray-200">Limitarr</div>
                <div className="tabular-nums tracking-[0.15em] text-gray-300 text-sm">
                  {version.version}
                </div>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-gray-500 tabular-nums">
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
        {paused && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-accent-500 bg-accent-600/15 px-4 py-3 text-sm font-bold text-accent-300">
            <IconBan className="w-5 h-5 flex-shrink-0" />
            Pausa global activa: no se aprueba ninguna solicitud nueva.
          </div>
        )}
        <Component />
      </main>

      <WhatsNewModal />
    </div>
  );
}
