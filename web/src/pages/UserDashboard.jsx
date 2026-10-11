import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Wordmark } from '../components/Brand.jsx';
import { IconBell, IconLogout, IconGauge, IconFilm, IconSave } from '../icons.jsx';
import { PendingDetailModal, MonthlyHistoryModal, RecentlyWatchedPoster } from './Quota.jsx';
import { SalvadosGrid } from '../components/Salvados.jsx';
import { downloadStatusLabel, downloadStatusBg, downloadStatusChipText } from '../mediaStatus.js';

function LibraryCard({ library, onDetail }) {
  const percent = library.limitApplied > 0 ? Math.max(0, Math.min(100, (library.balance / library.limitApplied) * 100)) : 0;
  return (
    <section className="py-7 sm:py-9 text-black border-b border-gray-200 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-gray-500">Biblioteca</p>
          <h3 className="font-black tracking-tight text-2xl mt-1">{library.libraryName}</h3>
          <p className="text-sm text-gray-500 mt-1">{library.outstanding} pendiente{library.outstanding === 1 ? '' : 's'} de ver</p>
        </div>
        <div className="text-right">
          <div className="text-5xl leading-none font-black tracking-[-0.06em] text-black">{library.balance}</div>
          <div className="text-xs font-bold text-gray-500 mt-1">de {library.limitApplied} libres</div>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-gray-200 mt-6 overflow-hidden">
        <div className="h-full rounded-full bg-black" style={{ width: `${percent}%` }} />
      </div>
      {library.pendingItems?.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mt-5">
          {library.pendingItems.map((item, index) => (
            <div key={`${item.tmdbId ?? item.title}-${index}`}>
              <button
                type="button"
                onClick={() => onDetail(item)}
                aria-label={`Ver detalle de ${item.title}`}
                className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-bg-950 text-left transition-transform active:scale-[.98]"
                title={item.pendingApproval
                  ? item.sequentialQueue
                    ? `${item.title} — pendiente de aprobar cuando se vea la temporada ${item.previousSeasonNumber ?? 'anterior'}, no cuenta`
                    : `${item.title} — pendiente de aprobar, no cuenta`
                  : item.bypassed
                    ? `${item.title} — aprobada fuera de limitARR, no cuenta`
                    : item.unavailable
                      ? `${item.title} — ${downloadStatusLabel(item)}, no cuenta`
                      : item.title}
              >
                {item.posterUrl ? (
                  <img
                    src={item.posterUrl}
                    alt=""
                    loading="lazy"
                    className={`h-full w-full object-cover ${item.unavailable || item.pendingApproval ? 'grayscale opacity-60' : ''}`}
                  />
                ) : <div className="h-full w-full bg-gradient-to-br from-bg-600 to-bg-800" />}
                {(item.unavailable || item.pendingApproval) && (
                  <div className="absolute left-1 top-1 right-1 flex flex-col items-start gap-0.5">
                    <span className="min-w-0 max-w-full truncate rounded bg-indigo-600 px-1 py-0.5 text-[7px] leading-none font-bold uppercase tracking-wide text-white">
                      No cuenta
                    </span>
                    <span className={`min-w-0 max-w-full line-clamp-2 rounded px-1 py-0.5 text-[7px] leading-tight font-semibold uppercase tracking-wide ${item.pendingApproval ? 'text-white bg-violet-600' : `${downloadStatusBg(item)} ${downloadStatusChipText(item)}`}`}>
                      {item.pendingApproval
                        ? item.sequentialQueue ? 'Espera t. anterior' : 'Pdte. de aprobar'
                        : downloadStatusLabel(item)}
                    </span>
                  </div>
                )}
                {item.bypassed && !item.unavailable && !item.pendingApproval && (
                  <span className="absolute left-1 top-1 right-1 truncate rounded bg-violet-600 px-1 py-0.5 text-[7px] leading-none font-bold uppercase tracking-wide text-white">
                    No cuenta (aparte)
                  </span>
                )}
              </button>
              <p className="text-[11px] text-gray-600 mt-1 line-clamp-2">{item.title}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function UserDashboard({ session, impersonating, onLoggedOut }) {
  const [quota, setQuota] = useState(null);
  const [salvados, setSalvados] = useState([]);
  const [link, setLink] = useState(null);
  const [chatId, setChatId] = useState('');
  const [showManualLink, setShowManualLink] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);
  // Historial de cupo mensual abierto (issue #20, también en el panel de
  // usuario): { lib } o { lib: null } para el total. null = cerrado.
  const [historyTarget, setHistoryTarget] = useState(null);
  const connectingRef = useRef(false);
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
  const totalFree = useMemo(
    () => (quota?.libraries ?? []).reduce((sum, library) => sum + Math.max(0, library.balance ?? 0), 0),
    [quota]
  );
  const totalPending = useMemo(
    () => (quota?.libraries ?? []).reduce((sum, library) => sum + Math.max(0, library.outstanding ?? 0), 0),
    [quota]
  );

  useEffect(() => {
    Promise.all([api.myQuota(), api.myNotifications()])
      .then(([quotaValue, linkValue]) => {
        setQuota(quotaValue);
        setLink(linkValue);
        setChatId(linkValue?.chat_id ?? '');
      })
      .catch(() => setError('No se pudo cargar tu cupo. Inténtalo de nuevo más tarde.'));
    // Las salvadas son un extra: si el módulo Maintainerr no está, no rompe el panel.
    api.mySalvados().then(setSalvados).catch(() => {});
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

  async function logout() {
    await api.logout();
    onLoggedOut();
  }

  async function stopImpersonating() {
    await api.stopImpersonating();
    onLoggedOut();
  }

  return (
    <div className="min-h-screen bg-white text-gray-950">
      <header className="border-b border-gray-200 bg-white/95 sticky top-0 z-10 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto h-[72px] px-5 sm:px-8 flex items-center justify-between">
          <Wordmark className="text-2xl" dark />
          <div className="flex items-center gap-3 text-sm text-gray-600">
            <span>{session?.username}</span>
            {impersonating ? (
              <button onClick={stopImpersonating} className="btn btn-ghost py-1 px-2.5 text-xs">Volver a admin</button>
            ) : (
              <button onClick={logout} aria-label="Cerrar sesión" className="p-2 hover:text-black"><IconLogout className="w-5 h-5" /></button>
            )}
          </div>
        </div>
      </header>
      {impersonating && (
        <div className="bg-accent-600/15 border-b border-accent-500/30 text-accent-200 text-xs sm:text-sm text-center py-2 px-4">
          Estás viendo el panel de <strong>{session?.username}</strong> como administrador.
        </div>
      )}
      <main className="max-w-6xl mx-auto p-5 sm:p-8 lg:py-12 pb-28 sm:pb-8">
        <section id="resumen" className="scroll-mt-24 text-black pt-2 sm:pt-4 pb-9 border-b border-gray-200 mb-8">
          <div className="relative z-[1] flex flex-col sm:flex-row sm:items-end justify-between gap-8">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">Tu espacio disponible</p>
              <h1 className="text-4xl sm:text-5xl font-black tracking-[-0.055em] mt-3">Hola, {session?.username}</h1>
              <p className="text-sm text-gray-600 mt-3 max-w-lg">
                {quota?.isGroup ? `Cupo compartido con ${quota.members?.join(', ')}` : 'Todo lo que tienes disponible y pendiente, de un vistazo.'}
              </p>
            </div>
            <div className="flex gap-8 flex-shrink-0">
              <div>
                <div className="text-5xl font-black tracking-[-0.07em] tabular-nums">{quota ? totalFree : '—'}</div>
                <div className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-500 mt-1">huecos libres</div>
              </div>
              <div>
                <div className="text-5xl font-black tracking-[-0.07em] tabular-nums">{quota ? totalPending : '—'}</div>
                <div className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-500 mt-1">sin ver</div>
              </div>
            </div>
          </div>
        </section>
        {error && <div role="alert" className="py-4 mb-5 border-y border-accent-200 text-accent-600">{error}</div>}
        <div id="bibliotecas" className="scroll-mt-24 flex items-end justify-between gap-4 mb-4 mt-8">
          <div>
            <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-gray-600">Resumen</p>
            <h2 className="text-2xl font-black tracking-tight mt-1">Mis bibliotecas</h2>
          </div>
        </div>
        <div>
          {quota?.libraries?.map((library) => (
            <LibraryCard
              key={library.libraryId}
              library={library}
              onDetail={(item) => setDetailTarget({ lib: library, item })}
            />
          ))}
        </div>
        {quota && quota.libraries?.length === 0 && <div className="py-8 border-y border-gray-200 text-gray-500">Todavía no hay cupo calculado para tu cuenta.</div>}

        {quota?.monthlyTotal?.enabled && (
          <section className="py-8 mt-8 border-t border-gray-200 text-black">
            <h2 className="font-extrabold text-xl mb-1">📅 Cupo mensual total</h2>
            <p className="text-sm text-gray-500 mb-4">
              Límite de cuántas puedes pedir al mes en total, sumando todas las bibliotecas
              (HD, 4K, series...) combinadas.
            </p>
            {(() => {
              const mt = quota.monthlyTotal;
              const pct = mt.limit > 0 ? Math.max(0, Math.min(100, (mt.used / mt.limit) * 100)) : 0;
              const maxed = mt.used >= mt.limit;
              return (
                <button
                  type="button"
                  onClick={() => setHistoryTarget({ lib: null })}
                  title="Ver qué has pedido este mes"
                  className="w-full text-left py-4 max-w-sm border-y border-gray-200 active:opacity-60"
                >
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-semibold">Todas las bibliotecas</span>
                    <div className={`text-2xl font-black tabular-nums ${maxed ? 'text-accent-500' : 'text-black'}`}>
                      {mt.used}<span className="text-sm text-gray-500 font-bold">/{mt.limit}</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full bg-gray-300 mt-3 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${maxed ? 'bg-accent-500' : 'bg-sky-400'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {maxed && (
                    <p className="text-xs text-accent-400 mt-2">
                      Cupo del mes agotado — se resetea en {mt.daysUntilReset} día{mt.daysUntilReset === 1 ? '' : 's'}
                    </p>
                  )}
                </button>
              );
            })()}
          </section>
        )}

        {quota?.libraries?.some((l) => l.monthly?.enabled) && (
          <section className="py-8 mt-8 border-t border-gray-200 text-black">
            <h2 className="font-extrabold text-xl mb-1">📅 Cupo mensual</h2>
            <p className="text-sm text-gray-500 mb-4">
              Límite de cuántas puedes pedir al mes — el tuyo si tienes uno particular, si no el general de la
              biblioteca. Cuentan aunque ya te las hayas visto.
            </p>
            <div className="divide-y divide-gray-200 border-t border-gray-200">
              {quota.libraries
                .filter((l) => l.monthly?.enabled)
                .map((l) => {
                  const pct = l.monthly.limit > 0 ? Math.max(0, Math.min(100, (l.monthly.used / l.monthly.limit) * 100)) : 0;
                  const maxed = l.monthly.used >= l.monthly.limit;
                  return (
                    <button
                      type="button"
                      key={l.libraryId}
                      onClick={() => setHistoryTarget({ lib: l })}
                      title="Ver qué has pedido este mes"
                      className="w-full text-left py-4 active:opacity-60"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <span className="font-semibold">{l.libraryName}</span>
                        <div className={`text-2xl font-black tabular-nums ${maxed ? 'text-accent-500' : 'text-black'}`}>
                          {l.monthly.used}<span className="text-sm text-gray-500 font-bold">/{l.monthly.limit}</span>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full bg-gray-300 mt-3 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${maxed ? 'bg-accent-500' : 'bg-sky-400'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {maxed && (
                        <p className="text-xs text-accent-400 mt-2">
                          Cupo del mes agotado — se resetea en {l.monthly.daysUntilReset} día{l.monthly.daysUntilReset === 1 ? '' : 's'}
                        </p>
                      )}
                    </button>
                  );
                })}
            </div>
          </section>
        )}

        {salvados.length > 0 && (
          <section id="salvadas" className="scroll-mt-24 py-8 mt-8 border-t border-gray-200 text-black">
            <h2 className="font-extrabold text-xl mb-1">💾 Salvadas para ver</h2>
            <p className="text-sm text-gray-500 mb-4">
              Películas que salvaste del borrado con el botón de Telegram. Cuando acabe la cuenta atrás, se borran.
            </p>
            <SalvadosGrid items={salvados} />
          </section>
        )}

        {quota?.recentlyWatched?.length > 0 && (
          <section className="py-8 mt-8 border-t border-gray-200 text-black">
            <h2 className="font-extrabold text-xl mb-1">Vistas en los últimos 30 días</h2>
            <p className="text-sm text-gray-500 mb-4">Lo que has pedido y ya has visto recientemente.</p>
            <div className="flex flex-wrap gap-2">
              {quota.recentlyWatched.map((item, i) => (
                <RecentlyWatchedPoster key={`${item.tmdbId ?? 'x'}-${item.seasonNumber ?? 0}-${i}`} item={item} />
              ))}
            </div>
          </section>
        )}

        <section id="avisos" className="scroll-mt-24 py-8 mt-8 border-t border-gray-200 text-black max-w-xl">
          <div className="flex items-center gap-3 mb-4"><span className="w-11 h-11 rounded-full bg-[#f3f3f3] flex items-center justify-center"><IconBell className="w-5 h-5 text-black" /></span><h2 className="font-extrabold text-xl">Mis avisos</h2></div>

          {link ? (
            <>
              <p className="text-sm text-gray-500 mb-4">
                Avisos activados por Telegram{link.label ? <> · <span className="text-gray-700">{link.label}</span></> : null}.
              </p>
              <button type="button" onClick={removeNotifications} className="btn btn-ghost">Desactivar</button>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-4">Un click y te avisamos por Telegram de los cambios en tu cupo.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={connectTelegram} disabled={connecting} className="btn !bg-black !text-white">
                  {connecting ? 'Esperando confirmación en Telegram…' : 'Vincular con Telegram'}
                </button>
                {connecting && <button type="button" onClick={cancelConnect} className="btn btn-ghost">Cancelar</button>}
              </div>
              {connecting && (
                <p className="text-xs text-gray-500 mt-3">Se ha abierto Telegram — pulsa "Iniciar" en el bot y vuelve aquí.</p>
              )}
              <button
                type="button"
                onClick={() => setShowManualLink((v) => !v)}
                className="text-xs text-gray-500 hover:text-gray-300 mt-4 underline block"
              >
                {showManualLink ? 'Ocultar' : '¿No se abre Telegram? Pega el ID del chat a mano'}
              </button>
              {showManualLink && (
                <form onSubmit={saveNotifications} className="space-y-3 mt-3">
                  <input aria-label="ID del chat de Telegram" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="ID del chat de Telegram" className="input" required />
                  <button className="btn btn-ghost">Activar avisos</button>
                </form>
              )}
            </>
          )}
          {message && <p aria-live="polite" className={`text-sm mt-3 ${message.startsWith('No ') ? 'text-accent-400' : 'text-green-400'}`}>{message}</p>}
        </section>
      </main>
      <nav aria-label="Navegación del panel" className="sm:hidden fixed inset-x-0 bottom-0 z-40 h-[76px] border-t border-gray-200 bg-white px-2 py-1.5 flex items-stretch justify-around">
        {[
          { href: '#resumen', label: 'Inicio', Icon: IconGauge },
          { href: '#bibliotecas', label: 'Cupo', Icon: IconFilm },
          ...(salvados.length > 0 ? [{ href: '#salvadas', label: 'Salvadas', Icon: IconSave }] : []),
          { href: '#avisos', label: 'Avisos', Icon: IconBell },
        ].map(({ href, label, Icon }) => (
          <a key={href} href={href} className="min-w-[70px] flex flex-col items-center justify-center gap-1 text-[10px] font-extrabold text-gray-500 active:text-black">
            <Icon className="w-5 h-5" />
            {label}
          </a>
        ))}
      </nav>
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
