import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Wordmark } from '../components/Brand.jsx';
import { IconBell, IconLogout } from '../icons.jsx';
import { PendingDetailModal } from './Quota.jsx';

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
                  <div className="absolute left-1 top-1 flex max-w-[calc(100%-0.5rem)] flex-col items-start gap-1">
                    <span className="rounded bg-black/80 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300">
                      No cuenta
                    </span>
                    <span className="rounded bg-black/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-gray-200">
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

function downloadStatusLabel(item) {
  if (Number(item.mediaStatus) === 2) return 'Pendiente de descarga';
  if (Number(item.mediaStatus) === 3) return 'Descargando';
  return 'Sin descargar';
}

export default function UserDashboard({ session, onLoggedOut }) {
  const [quota, setQuota] = useState(null);
  const [link, setLink] = useState(null);
  const [chatId, setChatId] = useState('');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);
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
  }, []);

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

  return (
    <div className="min-h-screen bg-bg-950 text-gray-100">
      <header className="border-b border-bg-700/60 bg-bg-900/90 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-5xl mx-auto h-16 px-4 flex items-center justify-between">
          <Wordmark className="text-2xl" />
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span>{session?.username}</span>
            <button onClick={logout} aria-label="Cerrar sesión" className="p-2 hover:text-white"><IconLogout className="w-5 h-5" /></button>
          </div>
        </div>
      </header>
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

        <section className="card p-5 mt-8 max-w-xl">
          <div className="flex items-center gap-3 mb-4"><IconBell className="w-6 h-6 text-accent-400" /><h2 className="font-extrabold text-xl">Mis avisos</h2></div>
          <p className="text-sm text-gray-500 mb-4">Escribe al bot de Telegram y pega aquí el identificador de tu chat para recibir cambios de cupo.</p>
          <form onSubmit={saveNotifications} className="space-y-3">
            <input aria-label="ID del chat de Telegram" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="ID del chat de Telegram" className="input" required />
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary">{link ? 'Actualizar avisos' : 'Activar avisos'}</button>
              {link && <button type="button" onClick={removeNotifications} className="btn btn-ghost">Desactivar</button>}
            </div>
          </form>
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
