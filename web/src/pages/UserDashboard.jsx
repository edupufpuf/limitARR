import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Wordmark } from '../components/Brand.jsx';
import { IconBell, IconLogout } from '../icons.jsx';
import { PendingDetailModal } from './Quota.jsx';
import { SalvadosGrid } from '../components/Salvados.jsx';
import { downloadStatusLabel, downloadStatusColor, downloadStatusBg } from '../mediaStatus.js';

function LibraryCard({ library, onDetail }) {
  const percent = library.limitApplied > 0 ? Math.max(0, Math.min(100, (library.balance / library.limitApplied) * 100)) : 0;
  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-extrabold text-lg">{library.libraryName}</h3>
          <p className="text-sm text-gray-400">{library.outstanding} pendiente{library.outstanding === 1 ? '' : 's'} de ver</p>
        </div>
        <div className="text-right">
          <div className="text-3xl font-black text-white">{library.balance}</div>
          <div className="text-xs text-gray-500">de {library.limitApplied} libres</div>
        </div>
      </div>
      <div className="h-2 rounded-full bg-bg-950 mt-4 overflow-hidden">
        <div className="h-full rounded-full bg-accent-500" style={{ width: `${percent}%` }} />
      </div>
      {library.pendingItems?.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mt-5">
          {library.pendingItems.map((item, index) => (
            <div key={`${item.tmdbId ?? item.title}-${index}`}>
              <button
                type="button"
                onClick={() => onDetail(item)}
                aria-label={`Ver detalle de ${item.title}`}
                className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-bg-950 text-left"
                title={item.pendingApproval
                  ? `${item.title} — pendiente de aprobar, no cuenta`
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
                    <span className="min-w-0 max-w-full truncate rounded bg-amber-500/20 ring-1 ring-inset ring-amber-500/40 px-1 py-0.5 text-[7px] leading-none font-bold uppercase tracking-wide text-amber-300">
                      No cuenta
                    </span>
                    <span className={`min-w-0 max-w-full truncate rounded px-1 py-0.5 text-[7px] leading-none font-semibold uppercase tracking-wide ${item.pendingApproval ? 'text-violet-300 bg-violet-500/20 ring-1 ring-inset ring-violet-500/40' : `${downloadStatusColor(item)} ${downloadStatusBg(item)}`}`}>
                      {item.pendingApproval ? 'Pdte. de aprobar' : downloadStatusLabel(item)}
                    </span>
                  </div>
                )}
              </button>
              <p className="text-[11px] text-gray-400 mt-1 line-clamp-2">{item.title}</p>
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
  const connectingRef = useRef(false);
  const loadUserDetail = useCallback(
    (params) => api.myPendingDetail(detailTarget?.lib.libraryId, params),
    [detailTarget?.lib.libraryId]
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
    <div className="min-h-screen bg-bg-950 text-gray-100">
      <header className="border-b border-bg-700/60 bg-bg-900/90 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-5xl mx-auto h-16 px-4 flex items-center justify-between">
          <Wordmark className="text-2xl" />
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span>{session?.username}</span>
            {impersonating ? (
              <button onClick={stopImpersonating} className="btn btn-ghost py-1 px-2.5 text-xs">Volver a admin</button>
            ) : (
              <button onClick={logout} aria-label="Cerrar sesión" className="p-2 hover:text-white"><IconLogout className="w-5 h-5" /></button>
            )}
          </div>
        </div>
      </header>
      {impersonating && (
        <div className="bg-accent-600/15 border-b border-accent-500/30 text-accent-200 text-xs sm:text-sm text-center py-2 px-4">
          Estás viendo el panel de <strong>{session?.username}</strong> como administrador.
        </div>
      )}
      <main className="max-w-5xl mx-auto p-4 sm:p-8">
        <h1 className="page-title">Mi cupo</h1>
        <p className="text-sm text-gray-500 mt-1 mb-6">
          {quota?.isGroup ? `Cupo compartido con ${quota.members?.join(', ')}` : 'Tu disponibilidad actual en Plex'}
        </p>
        {error && <div role="alert" className="card p-4 mb-5 text-accent-400">{error}</div>}
        <div className="grid md:grid-cols-2 gap-4">
          {quota?.libraries?.map((library) => (
            <LibraryCard
              key={library.libraryId}
              library={library}
              onDetail={(item) => setDetailTarget({ lib: library, item })}
            />
          ))}
        </div>
        {quota && quota.libraries?.length === 0 && <div className="card p-6 text-gray-400">Todavía no hay cupo calculado para tu cuenta.</div>}

        {quota?.libraries?.some((l) => l.monthly?.enabled) && (
          <section className="card p-5 mt-8">
            <h2 className="font-extrabold text-xl mb-1">📅 Cupo mensual</h2>
            <p className="text-sm text-gray-500 mb-4">
              Límite de cuántas puedes pedir al mes — el tuyo si tienes uno particular, si no el general de la
              biblioteca. Cuentan aunque ya te las hayas visto.
            </p>
            <div className="grid sm:grid-cols-2 gap-4">
              {quota.libraries
                .filter((l) => l.monthly?.enabled)
                .map((l) => {
                  const pct = l.monthly.limit > 0 ? Math.max(0, Math.min(100, (l.monthly.used / l.monthly.limit) * 100)) : 0;
                  const maxed = l.monthly.used >= l.monthly.limit;
                  return (
                    <div key={l.libraryId} className="rounded-xl bg-bg-950/60 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <span className="font-semibold">{l.libraryName}</span>
                        <div className={`text-2xl font-black tabular-nums ${maxed ? 'text-accent-400' : 'text-white'}`}>
                          {l.monthly.used}<span className="text-sm text-gray-500 font-bold">/{l.monthly.limit}</span>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full bg-bg-800 mt-3 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${maxed ? 'bg-accent-500' : 'bg-sky-400'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {maxed && <p className="text-xs text-accent-400 mt-2">Cupo del mes agotado</p>}
                    </div>
                  );
                })}
            </div>
          </section>
        )}

        {salvados.length > 0 && (
          <section className="card p-5 mt-8">
            <h2 className="font-extrabold text-xl mb-1">💾 Salvadas para ver</h2>
            <p className="text-sm text-gray-500 mb-4">
              Películas que salvaste del borrado con el botón de Telegram. Cuando acabe la cuenta atrás, se borran.
            </p>
            <SalvadosGrid items={salvados} />
          </section>
        )}

        <section className="card p-5 mt-8 max-w-xl">
          <div className="flex items-center gap-3 mb-4"><IconBell className="w-6 h-6 text-accent-400" /><h2 className="font-extrabold text-xl">Mis avisos</h2></div>

          {link ? (
            <>
              <p className="text-sm text-gray-500 mb-4">
                Avisos activados por Telegram{link.label ? <> · <span className="text-gray-300">{link.label}</span></> : null}.
              </p>
              <button type="button" onClick={removeNotifications} className="btn btn-ghost">Desactivar</button>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500 mb-4">Un click y te avisamos por Telegram de los cambios en tu cupo.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={connectTelegram} disabled={connecting} className="btn btn-primary">
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
    </div>
  );
}
