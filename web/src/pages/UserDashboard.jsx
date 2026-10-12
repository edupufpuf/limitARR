import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Wordmark } from '../components/Brand.jsx';
import { IconBell, IconCalendar, IconChevronRight, IconEye, IconFilm, IconLogout, IconQuestion, IconSave, IconUsers } from '../icons.jsx';
import { PendingDetailModal, MonthlyHistoryModal, RecentlyWatchedPoster } from './Quota.jsx';
import { SalvadosGrid } from '../components/Salvados.jsx';
import { QuotaHelpSheet } from '../components/QuotaHelp.jsx';
import Sheet from '../components/Sheet.jsx';
import ThemeSwitch from '../components/ThemeSwitch.jsx';
import { downloadStatusLabel } from '../mediaStatus.js';

// Panel del usuario con estética de app de consumo (tipo Uber): la pantalla
// principal solo dice cuánto cupo queda en cada biblioteca; todo lo demás
// (pósters, mensual, salvadas, avisos, ayuda) vive en hojas inferiores.

function pct(used, limit) {
  return limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function Bar({ percent, tone = 'bg-ink' }) {
  return (
    <div className="h-1 rounded-full bg-bg-700 overflow-hidden">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function itemNote(item) {
  if (item.pendingApproval) return item.sequentialQueue ? 'Espera temporada anterior' : 'Pendiente de aprobar';
  if (item.bypassed) return 'Aprobada aparte';
  if (item.unavailable) return downloadStatusLabel(item);
  return null;
}

function PosterTile({ item, onClick }) {
  const note = itemNote(item);
  const muted = item.unavailable || item.pendingApproval;
  return (
    <button type="button" onClick={onClick} className="text-left group" title={note ? `${item.title} — ${note}, no cuenta` : item.title}>
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-bg-800">
        {item.posterUrl
          ? <img src={item.posterUrl} alt="" loading="lazy" className={`h-full w-full object-cover transition-transform group-active:scale-[.97] ${muted ? 'grayscale opacity-50' : ''}`} />
          : <div className="h-full w-full bg-bg-700" />}
        {note && (
          <span className="absolute left-1.5 bottom-1.5 right-1.5 line-clamp-2 rounded-md bg-bg-900/95 px-1.5 py-1 text-[10px] font-semibold leading-tight text-gray-100">
            {note}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-gray-400 line-clamp-1">{item.title}</p>
    </button>
  );
}

function LibraryRow({ library, onOpen }) {
  const empty = library.limitApplied > 0 && library.balance <= 0;
  return (
    <button type="button" onClick={onOpen} className="row">
      <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-bg-800">
        <IconFilm className="h-6 w-6 text-gray-100" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block font-semibold text-gray-50 truncate">{library.libraryName}</span>
        <span className="block text-sm text-gray-500">
          {library.outstanding > 0 ? `${plural(library.outstanding, 'pendiente', 'pendientes')} de ver` : 'Nada pendiente'}
        </span>
      </span>
      <span className="text-right">
        <span className={`block text-2xl font-bold tabular-nums leading-none ${empty ? 'text-accent-400' : 'text-gray-50'}`}>{library.balance}</span>
        <span className="block mt-1 text-xs text-gray-500">de {library.limitApplied}</span>
      </span>
      <IconChevronRight className="h-5 w-5 flex-shrink-0 text-gray-600" />
    </button>
  );
}

function LibrarySheet({ library, onClose, onDetail, onMonthly }) {
  const empty = library.limitApplied > 0 && library.balance <= 0;
  const items = library.pendingItems ?? [];
  return (
    <Sheet title={library.libraryName} onClose={onClose}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className={`text-6xl font-bold tracking-tight tabular-nums leading-none ${empty ? 'text-accent-400' : 'text-gray-50'}`}>{library.balance}</div>
          <div className="mt-2 text-sm text-gray-500">libres de {library.limitApplied}</div>
        </div>
        {empty && <span className="rounded-full bg-accent-600 px-3 py-1 text-xs font-semibold text-white">Sin cupo</span>}
      </div>
      <div className="mt-4"><Bar percent={pct(library.balance, library.limitApplied)} tone={empty ? 'bg-accent-500' : 'bg-ink'} /></div>

      {library.monthly?.enabled && (
        <button type="button" onClick={onMonthly} className="row mt-4 border-t border-bg-700">
          <IconCalendar className="h-5 w-5 text-gray-400" />
          <span className="flex-1 text-sm font-semibold">Este mes</span>
          <span className={`text-sm font-semibold tabular-nums ${library.monthly.used >= library.monthly.limit ? 'text-accent-400' : 'text-gray-50'}`}>
            {library.monthly.used}/{library.monthly.limit}
          </span>
          <IconChevronRight className="h-4 w-4 text-gray-600" />
        </button>
      )}

      <h3 className="mt-6 mb-3 text-sm font-semibold text-gray-500">Pendiente de ver</h3>
      {items.length === 0
        ? <p className="py-6 text-center text-sm text-gray-500">No tienes nada pendiente aquí.</p>
        : (
          <div className="grid grid-cols-3 gap-3">
            {items.map((item, index) => (
              <PosterTile key={`${item.tmdbId ?? item.title}-${index}`} item={item} onClick={() => onDetail(item)} />
            ))}
          </div>
        )}
    </Sheet>
  );
}

function MonthlyRow({ label, used, limit, daysUntilReset, onClick }) {
  const maxed = used >= limit;
  return (
    <button type="button" onClick={onClick} className="row">
      <span className="flex-1 min-w-0">
        <span className="block font-semibold truncate">{label}</span>
        <span className="block mt-2"><Bar percent={pct(used, limit)} tone={maxed ? 'bg-accent-500' : 'bg-ink'} /></span>
        {maxed && <span className="block mt-1.5 text-xs text-accent-400">Agotado · vuelve en {plural(daysUntilReset, 'día', 'días')}</span>}
      </span>
      <span className={`text-xl font-bold tabular-nums ${maxed ? 'text-accent-400' : 'text-gray-50'}`}>
        {used}<span className="text-sm text-gray-500 font-medium">/{limit}</span>
      </span>
      <IconChevronRight className="h-5 w-5 text-gray-600" />
    </button>
  );
}

function MonthlySheet({ quota, onClose, onHistory }) {
  const mt = quota.monthlyTotal;
  const perLibrary = quota.libraries.filter((l) => l.monthly?.enabled);
  return (
    <Sheet title="Este mes" subtitle="Lo pedido cuenta aunque ya lo hayas visto." onClose={onClose}>
      {mt?.enabled && (
        <MonthlyRow label="Todas las bibliotecas" used={mt.used} limit={mt.limit} daysUntilReset={mt.daysUntilReset} onClick={() => onHistory(null)} />
      )}
      {perLibrary.map((l) => (
        <MonthlyRow key={l.libraryId} label={l.libraryName} used={l.monthly.used} limit={l.monthly.limit} daysUntilReset={l.monthly.daysUntilReset} onClick={() => onHistory(l)} />
      ))}
    </Sheet>
  );
}

function NotificationsSheet({ session, onClose }) {
  const [link, setLink] = useState(undefined);
  const [chatId, setChatId] = useState('');
  const [showManualLink, setShowManualLink] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState(null);
  const connectingRef = useRef(false);

  useEffect(() => {
    api.myNotifications()
      .then((value) => { setLink(value); setChatId(value?.chat_id ?? ''); })
      .catch(() => setLink(null));
    return () => { connectingRef.current = false; };
  }, []);

  // Un click: abre Telegram con /start precargado (deep link con token de un
  // solo uso) y sondea hasta que el bot lo resuelve y guarda el chat — el
  // usuario no tiene que copiar ningún ID ni pasar por el admin.
  async function connectTelegram() {
    setMessage(null);
    setConnecting(true);
    connectingRef.current = true;
    try {
      const { token, botUsername } = await api.myNotificationLinkToken();
      window.open(`https://t.me/${botUsername}?start=${token}`, '_blank');
      for (let i = 0; i < 40 && connectingRef.current; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const linkValue = await api.myNotifications();
        if (linkValue) {
          setLink(linkValue);
          setChatId(linkValue.chat_id);
          setMessage('Avisos activados');
          connectingRef.current = false;
          break;
        }
      }
    } catch {
      setMessage('No se pudo iniciar la vinculación');
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }

  function cancelConnect() {
    connectingRef.current = false;
    setConnecting(false);
  }

  async function saveNotifications(e) {
    e.preventDefault();
    try {
      await api.updateMyNotifications({ chatId, label: session?.username });
      setLink({ chat_id: chatId });
      setMessage('Avisos guardados');
    } catch {
      setMessage('No se pudieron guardar los avisos');
    }
  }

  async function removeNotifications() {
    try {
      await api.deleteMyNotifications();
      setLink(null);
      setChatId('');
      setMessage('Avisos desactivados');
    } catch {
      setMessage('No se pudieron desactivar los avisos');
    }
  }

  return (
    <Sheet title="Avisos" subtitle="Te escribimos por Telegram cuando cambia tu cupo." onClose={onClose}>
      {link === undefined && <p className="py-4 text-sm text-gray-500">Cargando…</p>}
      {link && (
        <>
          <div className="flex items-center gap-3 rounded-2xl bg-bg-800 p-4">
            <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
            <span className="flex-1 text-sm font-semibold">Activados{link.label ? ` · ${link.label}` : ''}</span>
          </div>
          <button type="button" onClick={removeNotifications} className="btn btn-ghost w-full mt-3">Desactivar</button>
        </>
      )}
      {link === null && (
        <>
          <button type="button" onClick={connectTelegram} disabled={connecting} className="btn btn-dark w-full">
            {connecting ? 'Esperando confirmación…' : 'Vincular con Telegram'}
          </button>
          {connecting && (
            <>
              <p className="mt-3 text-sm text-gray-500">Pulsa «Iniciar» en el bot y vuelve aquí.</p>
              <button type="button" onClick={cancelConnect} className="btn btn-ghost w-full mt-3">Cancelar</button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowManualLink((v) => !v)}
            className="mt-4 block text-xs text-gray-500 underline hover:text-gray-300"
          >
            {showManualLink ? 'Ocultar' : '¿No se abre Telegram? Pega el ID del chat'}
          </button>
          {showManualLink && (
            <form onSubmit={saveNotifications} className="mt-3 space-y-3">
              <input aria-label="ID del chat de Telegram" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="ID del chat de Telegram" className="input" required />
              <button className="btn btn-ghost w-full">Activar avisos</button>
            </form>
          )}
        </>
      )}
      {message && <p aria-live="polite" className={`mt-3 text-sm ${message.startsWith('No ') ? 'text-accent-400' : 'text-green-600'}`}>{message}</p>}
    </Sheet>
  );
}

function AccountSheet({ session, quota, impersonating, onClose, onLogout, onStopImpersonating }) {
  return (
    <Sheet title={session?.username ?? 'Cuenta'} subtitle={quota?.isGroup ? `Cupo compartido con ${quota.members?.join(', ')}` : 'Cuenta de Plex'} onClose={onClose}>
      <h3 className="mb-2 text-sm font-semibold text-gray-500">Apariencia</h3>
      <ThemeSwitch className="mb-6" />
      {impersonating ? (
        <button type="button" onClick={onStopImpersonating} className="btn btn-dark w-full">Volver a admin</button>
      ) : (
        <button type="button" onClick={onLogout} className="row">
          <IconLogout className="h-5 w-5 text-gray-400" />
          <span className="flex-1 font-semibold">Cerrar sesión</span>
        </button>
      )}
    </Sheet>
  );
}

export default function UserDashboard({ session, impersonating, onLoggedOut }) {
  const [quota, setQuota] = useState(null);
  const [salvados, setSalvados] = useState([]);
  const [error, setError] = useState(null);
  // Hoja abierta: 'library' | 'monthly' | 'salvadas' | 'watched' | 'notifications' | 'help' | 'account'.
  const [sheet, setSheet] = useState(null);
  const [openLibraryId, setOpenLibraryId] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);
  // Historial de cupo mensual abierto (issue #20, también en el panel de
  // usuario): { lib } o { lib: null } para el total. null = cerrado.
  const [historyTarget, setHistoryTarget] = useState(null);
  const loadUserDetail = useCallback(
    (params) => api.myPendingDetail(detailTarget?.lib.libraryId, params),
    [detailTarget?.lib.libraryId]
  );
  const loadUserHistory = useCallback(
    (lib) => (lib ? api.myMonthlyHistory(lib.libraryId) : api.myMonthlyHistoryTotal()),
    []
  );
  const libraryNameById = useMemo(
    () => new Map((quota?.libraries ?? []).map((l) => [l.libraryId, l.libraryName])),
    [quota]
  );
  const closeSheet = useCallback(() => setSheet(null), []);

  useEffect(() => {
    api.myQuota()
      .then(setQuota)
      .catch(() => setError('No se pudo cargar tu cupo. Inténtalo de nuevo más tarde.'));
    // Las salvadas son un extra: si el módulo Maintainerr no está, no rompe el panel.
    api.mySalvados().then(setSalvados).catch(() => {});
  }, []);

  async function logout() {
    await api.logout();
    onLoggedOut();
  }

  async function stopImpersonating() {
    await api.stopImpersonating();
    onLoggedOut();
  }

  const libraries = quota?.libraries ?? [];
  const openLibrary = libraries.find((l) => l.libraryId === openLibraryId);
  const mt = quota?.monthlyTotal;
  const hasMonthly = mt?.enabled || libraries.some((l) => l.monthly?.enabled);
  const monthlyMaxed = (mt?.enabled && mt.used >= mt.limit) || libraries.some((l) => l.monthly?.enabled && l.monthly.used >= l.monthly.limit);
  const watched = quota?.recentlyWatched ?? [];
  const initial = (session?.username ?? '?').slice(0, 1).toUpperCase();

  return (
    <div className="min-h-screen bg-bg-950 text-gray-100">
      {impersonating && (
        <div className="bg-ink text-on-ink text-xs sm:text-sm px-4 py-2 flex items-center justify-center gap-3">
          <span>Viendo como <strong>{session?.username}</strong></span>
          <button type="button" onClick={stopImpersonating} className="underline font-semibold">Volver a admin</button>
        </div>
      )}
      <header className="sticky top-0 z-10 bg-bg-950/90 backdrop-blur">
        <div className="max-w-xl mx-auto h-16 px-5 flex items-center justify-between">
          <Wordmark className="text-2xl" />
          <button
            type="button"
            onClick={() => setSheet('account')}
            aria-label="Cuenta"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-800 font-bold text-gray-50 hover:bg-bg-700"
          >
            {quota?.isGroup ? <IconUsers className="h-5 w-5" /> : initial}
          </button>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-5 pt-4 pb-16">
        <h1 className="page-title">Hola, {session?.username}</h1>
        <p className="mt-1 text-gray-500">Esto es lo que te queda por pedir.</p>

        {error && <div role="alert" className="mt-6 rounded-2xl bg-accent-50 p-4 text-sm text-accent-400">{error}</div>}

        <section className="mt-6">
          {libraries.map((library) => (
            <LibraryRow
              key={library.libraryId}
              library={library}
              onOpen={() => { setOpenLibraryId(library.libraryId); setSheet('library'); }}
            />
          ))}
          {quota && libraries.length === 0 && (
            <p className="py-10 text-center text-gray-500">Todavía no hay cupo calculado para tu cuenta.</p>
          )}
          {!quota && !error && (
            <div className="space-y-3 py-2" aria-hidden="true">
              {[0, 1].map((i) => <div key={i} className="h-16 rounded-2xl bg-bg-800 animate-pulse" />)}
            </div>
          )}
        </section>

        {quota && (
          <nav aria-label="Más" className="mt-8 -mx-5 px-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
            {hasMonthly && (
              <button type="button" onClick={() => setSheet('monthly')} className={`chip ${monthlyMaxed ? 'bg-accent-50 text-accent-400' : ''}`}>
                <IconCalendar className="h-4 w-4" />
                Este mes
                {mt?.enabled && <span className="tabular-nums text-gray-500">{mt.used}/{mt.limit}</span>}
              </button>
            )}
            {salvados.length > 0 && (
              <button type="button" onClick={() => setSheet('salvadas')} className="chip">
                <IconSave className="h-4 w-4" />
                Salvadas <span className="text-gray-500">{salvados.length}</span>
              </button>
            )}
            {watched.length > 0 && (
              <button type="button" onClick={() => setSheet('watched')} className="chip">
                <IconEye className="h-4 w-4" />
                Vistas <span className="text-gray-500">{watched.length}</span>
              </button>
            )}
            <button type="button" onClick={() => setSheet('notifications')} className="chip">
              <IconBell className="h-4 w-4" />
              Avisos
            </button>
            <button type="button" onClick={() => setSheet('help')} className="chip">
              <IconQuestion className="h-4 w-4" />
              Ayuda
            </button>
          </nav>
        )}
      </main>

      {sheet === 'library' && openLibrary && (
        <LibrarySheet
          library={openLibrary}
          onClose={closeSheet}
          onDetail={(item) => setDetailTarget({ lib: openLibrary, item })}
          onMonthly={() => setHistoryTarget({ lib: openLibrary })}
        />
      )}
      {sheet === 'monthly' && quota && (
        <MonthlySheet quota={quota} onClose={closeSheet} onHistory={(lib) => setHistoryTarget({ lib })} />
      )}
      {sheet === 'salvadas' && (
        <Sheet title="Salvadas" subtitle="Las salvaste del borrado. Cuando acabe la cuenta atrás, se borran." onClose={closeSheet}>
          <SalvadosGrid items={salvados} />
        </Sheet>
      )}
      {sheet === 'watched' && (
        <Sheet title="Vistas" subtitle="Lo que pediste y viste en los últimos 30 días." onClose={closeSheet}>
          <div className="flex flex-wrap gap-2">
            {watched.map((item, i) => (
              <RecentlyWatchedPoster key={`${item.tmdbId ?? 'x'}-${item.seasonNumber ?? 0}-${i}`} item={item} />
            ))}
          </div>
        </Sheet>
      )}
      {sheet === 'notifications' && <NotificationsSheet session={session} onClose={closeSheet} />}
      {sheet === 'help' && <QuotaHelpSheet onClose={closeSheet} />}
      {sheet === 'account' && (
        <AccountSheet
          session={session}
          quota={quota}
          impersonating={impersonating}
          onClose={closeSheet}
          onLogout={logout}
          onStopImpersonating={stopImpersonating}
        />
      )}

      {detailTarget && (
        <PendingDetailModal
          user={{ userId: session?.id, username: session?.username }}
          lib={detailTarget.lib}
          item={detailTarget.item}
          statsBase=""
          readOnly
          loadDetail={loadUserDetail}
          onClose={() => setDetailTarget(null)}
        />
      )}
      {historyTarget && (
        <MonthlyHistoryModal
          user={{ userId: session?.id, username: session?.username }}
          lib={historyTarget.lib}
          libraryNameById={libraryNameById}
          loadHistory={loadUserHistory}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}
