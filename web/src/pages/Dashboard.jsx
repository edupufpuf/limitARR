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
import { IconGauge, IconSave, IconFilm, IconUsers, IconClock, IconBell, IconGear, IconLogout, IconMenu, IconXCircle, IconBan } from '../icons.jsx';
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
  const { Component, label } = TABS[tab];
  const anyDirty = useAnyDirty();
  const mobileActiveTab = tab === 'movie-history' ? 'log' : tab;
  const mobileMoreActive = !MOBILE_TABS.includes(mobileActiveTab);

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
      {/* Fondo de la hoja inferior móvil. */}
      {menuOpen && (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setMenuOpen(false)}
          className="sm:hidden fixed inset-0 bg-black/65 z-40 backdrop-blur-sm"
        />
      )}

      {/* Sidebar original: solo escritorio. */}
      <nav className="hidden sm:flex sticky top-0 z-auto w-[220px] h-screen overflow-y-auto bg-gradient-to-b from-bg-900 via-bg-900 to-bg-950 border-r border-bg-700/55 px-4 py-6 flex-col flex-shrink-0 shadow-[18px_0_48px_-32px_rgba(0,0,0,.85)]">
        <div className="mb-8 flex items-center justify-between">
          <Wordmark className="text-[30px]" />
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
          {Object.entries(TABS).filter(([, item]) => !item.hidden).map(([key, { label, Icon }]) => (
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

      {/* Cabecera compacta tipo app — solo móvil. */}
      <header className="sm:hidden flex items-center justify-between px-4 h-16 bg-bg-900/90 border-b border-bg-700/60 flex-shrink-0 sticky top-0 z-30 backdrop-blur-xl">
        <Wordmark className="text-[23px]" />
        <div className="flex items-center gap-2 min-w-0">
          {paused && <span className="w-2 h-2 rounded-full bg-accent-400 animate-pulse" title="Pausa global activa" />}
          <span className="text-sm font-bold text-gray-300 truncate max-w-[170px]">{label}</span>
        </div>
      </header>

      {/* Menú secundario móvil en una hoja inferior, como una app nativa. */}
      {menuOpen && (
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Más secciones"
          className="sm:hidden fixed inset-x-0 bottom-0 z-50 rounded-t-[28px] border-t border-bg-600 bg-bg-900 px-4 pt-3 shadow-[0_-20px_60px_rgba(0,0,0,.55)]"
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        >
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-bg-600" />
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-lg font-extrabold">Más</div>
              <div className="text-xs text-gray-500">Administración de limitARR</div>
            </div>
            <button type="button" onClick={() => setMenuOpen(false)} aria-label="Cerrar" className="w-11 h-11 rounded-full bg-bg-800 flex items-center justify-center text-gray-300">
              <IconXCircle className="w-6 h-6" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {MOBILE_MORE_TABS.map((key) => {
              const { label: itemLabel, Icon } = TABS[key];
              return (
                <button key={key} type="button" onClick={() => goTab(key)} className={`min-h-[82px] rounded-2xl border flex flex-col items-center justify-center gap-2 text-xs font-bold ${tab === key ? 'border-accent-500 bg-accent-600/20 text-white' : 'border-bg-700 bg-bg-800/75 text-gray-300'}`}>
                  <Icon className="w-6 h-6" />
                  {itemLabel}
                </button>
              );
            })}
          </div>

          <button type="button" onClick={togglePause} disabled={pauseBusy} className={`mt-3 w-full min-h-12 rounded-2xl border px-4 flex items-center gap-3 text-left text-sm font-bold ${paused ? 'border-accent-500 bg-accent-600/20 text-accent-300' : 'border-bg-700 bg-bg-800/75 text-gray-300'}`}>
            <IconBan className="w-5 h-5" />
            {paused ? 'Reanudar solicitudes' : 'Pausar todas las solicitudes'}
          </button>
          <button type="button" onClick={logout} className="mt-2 w-full min-h-12 rounded-2xl px-4 flex items-center gap-3 text-left text-sm font-bold text-gray-400">
            <IconLogout className="w-5 h-5" />
            Cerrar sesión
          </button>
          {version && <div className="pt-2 text-center text-[11px] text-gray-600">limitARR {version.version} · {version.sha ?? 'dev'}</div>}
        </section>
      )}

      <main className="flex-1 px-3 pt-5 pb-28 sm:p-8 lg:p-10 overflow-x-hidden">
        {paused && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-accent-500 bg-accent-600/15 px-4 py-3 text-sm font-bold text-accent-300">
            <IconBan className="w-5 h-5 flex-shrink-0" />
            Pausa global activa: no se aprueba ninguna solicitud nueva.
          </div>
        )}
        <Component onNavigate={goTab} />
      </main>

      {/* Navegación principal persistente en móvil. */}
      <nav
        aria-label="Navegación principal"
        className="sm:hidden fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-bg-600/80 bg-bg-900/95 px-1 pt-1.5 backdrop-blur-xl shadow-[0_-12px_35px_rgba(0,0,0,.35)]"
        style={{ paddingBottom: 'max(.45rem, env(safe-area-inset-bottom))' }}
      >
        {MOBILE_TABS.map((key) => {
          const { label: itemLabel, Icon } = TABS[key];
          const active = mobileActiveTab === key;
          return (
            <button key={key} type="button" onClick={() => goTab(key)} aria-current={active ? 'page' : undefined} className={`min-h-[54px] rounded-xl flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition-colors ${active ? 'bg-accent-600/15 text-accent-300' : 'text-gray-500'}`}>
              <Icon className="w-[22px] h-[22px]" />
              {itemLabel}
            </button>
          );
        })}
        <button type="button" onClick={() => setMenuOpen(true)} aria-expanded={menuOpen} className={`min-h-[54px] rounded-xl flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition-colors ${mobileMoreActive || menuOpen ? 'bg-accent-600/15 text-accent-300' : 'text-gray-500'}`}>
          <IconMenu className="w-[22px] h-[22px]" />
          Más
        </button>
      </nav>

      <WhatsNewModal />
    </div>
  );
}
