import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Quota from './Quota.jsx';
import Salvadas from './Salvadas.jsx';
import Libraries from './Libraries.jsx';
import Users from './Users.jsx';
import DecisionsLog from './DecisionsLog.jsx';
import Settings from './Settings.jsx';
import Notifications from './Notifications.jsx';
import MovieHistory from './MovieHistory.jsx';
import WhatsNewModal from '../components/WhatsNewModal.jsx';
import { Wordmark } from '../components/Brand.jsx';
import { IconGauge, IconSave, IconFilm, IconUsers, IconClock, IconBell, IconGear, IconLogout, IconBan } from '../icons.jsx';
import { DirtyGuardProvider, useAnyDirty } from '../DirtyGuard.jsx';

const UNSAVED_WARNING = 'Hay cambios sin guardar en esta pestaña. ¿Salir igualmente?';

const TABS = {
  quota: { label: 'Cupo', Icon: IconGauge, Component: Quota },
  'movie-history': { label: 'Antigüedad de películas', Icon: IconFilm, Component: MovieHistory, hidden: true },
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
  }

  async function logout() {
    if (anyDirty() && !window.confirm(UNSAVED_WARNING)) return;
    await api.logout();
    onLoggedOut();
  }

  return (
    <div className="min-h-screen flex flex-col sm:flex-row bg-white text-gray-950">
      {/* Navegación tipo app: barra inferior en móvil y lateral en escritorio. */}
      <nav
        className="fixed inset-x-0 bottom-0 sm:sticky sm:inset-auto sm:top-0 z-40 sm:z-auto w-full sm:w-[232px] h-[76px] sm:h-screen overflow-x-auto sm:overflow-y-auto bg-white sm:bg-black border-t sm:border-t-0 sm:border-r border-gray-200 sm:border-bg-700 px-2 sm:px-4 py-1.5 sm:py-6 flex sm:flex-col flex-shrink-0"
      >
        <div className="hidden sm:flex mb-10 px-2 items-center justify-between">
          <Wordmark className="text-[30px]" />
        </div>
        <button
          onClick={togglePause}
          disabled={pauseBusy}
          title="Mientras está activo, ninguna solicitud nueva se aprueba: se queda en espera hasta que lo reactives."
          className={`hidden sm:flex items-center gap-2 w-full mb-5 px-3 py-2 rounded-lg text-xs font-bold text-left transition-colors border ${
            paused
              ? 'bg-accent-600/20 border-accent-500 text-accent-300 animate-pulse'
              : 'bg-bg-800/60 border-bg-600 text-gray-300 hover:text-white hover:bg-bg-800'
          }`}
        >
          <IconBan className="w-4 h-4 flex-shrink-0" />
          {paused ? 'Pausa global ACTIVA — tocar para reanudar' : 'Pausar todas las solicitudes'}
        </button>

        <div className="flex sm:block sm:space-y-1 gap-1 min-w-max sm:min-w-0 w-full">
          {Object.entries(TABS).filter(([, item]) => !item.hidden).map(([key, { label, Icon }]) => (
            <button
              key={key}
              onClick={() => goTab(key)}
              className={`relative flex min-w-[72px] sm:min-w-0 sm:min-h-12 flex-col sm:flex-row items-center justify-center sm:justify-start gap-1 sm:gap-3 sm:w-full text-center sm:text-left px-2 sm:px-4 py-2 sm:py-3 rounded-xl text-[10px] sm:text-[15px] leading-none font-extrabold tracking-tight transition-all ${
                tab === key
                  ? 'bg-[#f3f3f3] sm:bg-white text-black'
                  : 'text-gray-500 sm:text-gray-300 hover:text-black sm:hover:text-white hover:bg-gray-100 sm:hover:bg-bg-800'
              }`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={logout}
          className="hidden sm:flex min-h-11 items-center gap-3 mt-auto text-left px-4 py-2 rounded-xl text-sm font-bold text-gray-400 hover:text-white hover:bg-bg-800 transition-colors"
        >
          <IconLogout className="w-5 h-5 flex-shrink-0" />
          Cerrar sesión
        </button>
        {version && (
          <div className="hidden sm:block mt-3 rounded-lg border border-bg-600/90 bg-bg-950/45 px-3 py-3 text-sm text-gray-300 shadow-card">
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

      {/* Cabecera mínima — la navegación vive abajo, como en una app nativa. */}
      <header className="sm:hidden flex items-center justify-between px-5 h-[68px] bg-white/95 border-b border-gray-200 flex-shrink-0 sticky top-0 z-30 backdrop-blur-xl">
        <Wordmark className="text-[23px]" dark />
        <span className="text-[13px] font-extrabold text-gray-500">{label}</span>
        <div className="flex items-center gap-1">
          <button onClick={togglePause} disabled={pauseBusy} aria-label={paused ? 'Reanudar solicitudes' : 'Pausar solicitudes'} className={`p-2 rounded-full ${paused ? 'bg-accent-500 text-white' : 'text-gray-500'}`}>
            <IconBan className="w-5 h-5" />
          </button>
          <button onClick={logout} aria-label="Cerrar sesión" className="text-gray-500 p-2 -mr-2">
            <IconLogout className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 p-5 sm:p-8 lg:px-12 lg:py-10 pb-28 sm:pb-10 overflow-x-hidden max-w-[1680px] mx-auto w-full">
        {paused && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-accent-500 bg-accent-600/15 px-4 py-3 text-sm font-bold text-accent-300">
            <IconBan className="w-5 h-5 flex-shrink-0" />
            Pausa global activa: no se aprueba ninguna solicitud nueva.
          </div>
        )}
        <Component onNavigate={goTab} />
      </main>

      <WhatsNewModal />
    </div>
  );
}
