import { useCallback, useEffect, useState } from 'react';
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
import Sheet from '../components/Sheet.jsx';
import ThemeSwitch from '../components/ThemeSwitch.jsx';
import { IconGauge, IconSave, IconFilm, IconUsers, IconClock, IconBell, IconGear, IconLogout, IconMenu, IconBan, IconChevronRight } from '../icons.jsx';
import { DirtyGuardProvider, useAnyDirty } from '../DirtyGuard.jsx';

const UNSAVED_WARNING = 'Hay cambios sin guardar en esta pestaña. ¿Salir igualmente?';

const TABS = {
  quota: { label: 'Cupo', Icon: IconGauge, Component: Quota },
  'movie-history': { label: 'Antigüedad del contenido', Icon: IconFilm, Component: MovieHistory, hidden: true },
  salvadas: { label: 'Salvadas', Icon: IconSave, Component: Salvadas },
  libraries: { label: 'Bibliotecas', Icon: IconFilm, Component: Libraries },
  users: { label: 'Usuarios', Icon: IconUsers, Component: Users },
  log: { label: 'Registro', Icon: IconClock, Component: DecisionsLog },
  notifications: { label: 'Avisos', Icon: IconBell, Component: Notifications },
  settings: { label: 'Ajustes', Icon: IconGear, Component: Settings },
};

const MOBILE_TABS = ['quota', 'log', 'notifications', 'users'];
const MOBILE_MORE_TABS = ['salvadas', 'libraries', 'settings'];

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
  const { Component } = TABS[tab];
  const anyDirty = useAnyDirty();
  const mobileActiveTab = tab === 'movie-history' ? 'log' : tab;
  const mobileMoreActive = !MOBILE_TABS.includes(mobileActiveTab);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

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
      {/* Sidebar: solo escritorio. */}
      <nav className="hidden sm:flex sticky top-0 w-[232px] h-screen overflow-y-auto bg-bg-950 border-r border-bg-700 px-3 py-6 flex-col flex-shrink-0">
        <div className="mb-8 px-3">
          <Wordmark className="text-[28px]" />
        </div>

        <div className="space-y-0.5">
          {Object.entries(TABS).filter(([, item]) => !item.hidden).map(([key, { label, Icon }]) => {
            const active = tab === key || (key === 'log' && tab === 'movie-history');
            return (
              <button
                key={key}
                onClick={() => goTab(key)}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-xl text-[15px] transition-colors ${
                  active ? 'bg-bg-800 text-gray-50 font-semibold' : 'text-gray-400 hover:text-gray-50 hover:bg-bg-800/60'
                }`}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                {label}
              </button>
            );
          })}
        </div>

        <div className="mt-auto space-y-0.5">
          <ThemeSwitch className="mb-3" />
          <button
            onClick={togglePause}
            disabled={pauseBusy}
            title="Mientras está activo, ninguna solicitud nueva se aprueba: se queda en espera hasta que lo reactives."
            className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm text-left transition-colors ${
              paused ? 'bg-accent-600 text-white font-semibold' : 'text-gray-400 hover:text-gray-50 hover:bg-bg-800/60'
            }`}
          >
            <IconBan className="w-5 h-5 flex-shrink-0" />
            {paused ? 'Reanudar solicitudes' : 'Pausar solicitudes'}
          </button>
          <button
            onClick={logout}
            className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-xl text-sm text-gray-400 hover:text-gray-50 hover:bg-bg-800/60 transition-colors"
          >
            <IconLogout className="w-5 h-5 flex-shrink-0" />
            Cerrar sesión
          </button>
          {version && (
            <div className="px-3 pt-3 text-[11px] text-gray-600 tabular-nums">
              {version.version} · {version.sha ?? 'dev'}
              {version.updateAvailable && (
                <a
                  href="https://github.com/edupufpuf/limitARR"
                  target="_blank"
                  rel="noreferrer"
                  title={`Nueva imagen en GHCR: ${version.latestSha}`}
                  className="flex items-center gap-1.5 mt-1 font-semibold text-accent-400 hover:underline"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-500" />
                  Actualización disponible
                </a>
              )}
            </div>
          )}
        </div>
      </nav>

      {/* Cabecera compacta — solo móvil. */}
      <header className="sm:hidden flex items-center justify-between px-5 h-14 bg-bg-950/90 flex-shrink-0 sticky top-0 z-30 backdrop-blur">
        <Wordmark className="text-[22px]" />
      </header>

      {/* Menú secundario móvil en una hoja inferior. */}
      {menuOpen && (
        <Sheet title="Más" onClose={closeMenu}>
          {MOBILE_MORE_TABS.map((key) => {
            const { label: itemLabel, Icon } = TABS[key];
            return (
              <button key={key} type="button" onClick={() => goTab(key)} className="row">
                <Icon className={`w-5 h-5 ${tab === key ? 'text-gray-50' : 'text-gray-400'}`} />
                <span className={`flex-1 ${tab === key ? 'font-semibold text-gray-50' : ''}`}>{itemLabel}</span>
                <IconChevronRight className="w-4 h-4 text-gray-600" />
              </button>
            );
          })}
          <ThemeSwitch className="mt-4" />
          <button type="button" onClick={togglePause} disabled={pauseBusy} className={`btn w-full mt-3 ${paused ? 'btn-primary' : 'btn-ghost'}`}>
            <IconBan className="w-5 h-5" />
            {paused ? 'Reanudar solicitudes' : 'Pausar todas las solicitudes'}
          </button>
          <button type="button" onClick={logout} className="btn w-full mt-2 text-gray-400">
            <IconLogout className="w-5 h-5" />
            Cerrar sesión
          </button>
          {version && <div className="pt-2 text-center text-[11px] text-gray-600">limitARR {version.version} · {version.sha ?? 'dev'}</div>}
        </Sheet>
      )}

      <main className="flex-1 min-w-0 px-4 pt-3 pb-28 sm:px-10 sm:py-10 overflow-x-hidden">
        {paused && (
          <div className="mb-6 flex items-center gap-3 rounded-2xl bg-accent-600 px-4 py-3 text-sm font-semibold text-white">
            <IconBan className="w-5 h-5 flex-shrink-0" />
            <span className="flex-1">Pausa activa: no se aprueba nada nuevo.</span>
            <button type="button" onClick={togglePause} disabled={pauseBusy} className="underline">Reanudar</button>
          </div>
        )}
        <Component onNavigate={goTab} />
      </main>

      {/* Navegación principal persistente en móvil. */}
      <nav
        aria-label="Navegación principal"
        className="sm:hidden fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-bg-700 bg-bg-950/95 backdrop-blur px-1 pt-1"
        style={{ paddingBottom: 'max(.4rem, env(safe-area-inset-bottom))' }}
      >
        {MOBILE_TABS.map((key) => {
          const { label: itemLabel, Icon } = TABS[key];
          const active = mobileActiveTab === key;
          return (
            <button key={key} type="button" onClick={() => goTab(key)} aria-current={active ? 'page' : undefined} className={`min-h-[52px] flex flex-col items-center justify-center gap-1 text-[10px] transition-colors ${active ? 'text-gray-50 font-bold' : 'text-gray-600 font-medium'}`}>
              <Icon className="w-6 h-6" />
              {itemLabel}
            </button>
          );
        })}
        <button type="button" onClick={() => setMenuOpen(true)} aria-expanded={menuOpen} className={`relative min-h-[52px] flex flex-col items-center justify-center gap-1 text-[10px] transition-colors ${mobileMoreActive || menuOpen ? 'text-gray-50 font-bold' : 'text-gray-600 font-medium'}`}>
          <IconMenu className="w-6 h-6" />
          Más
          {paused && <span className="absolute top-2 right-[30%] w-2 h-2 rounded-full bg-accent-500" />}
        </button>
      </nav>

      <WhatsNewModal />
    </div>
  );
}
