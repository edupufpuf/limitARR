import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { IconSearch, IconUsers, IconEye, IconBan, IconCheckCircle, IconXCircle } from '../icons.jsx';

const REFRESH_MS = 60_000;

const STATUS = {
  danger: { text: 'text-accent-400', bar: 'bg-accent-500', ring: '#f87171' },
  warn: { text: 'text-yellow-400', bar: 'bg-yellow-400', ring: '#facc15' },
  ok: { text: 'text-green-400', bar: 'bg-green-400', ring: '#4ade80' },
};

function statusOf(balance) {
  if (balance <= 0) return STATUS.danger;
  if (balance <= 1) return STATUS.warn;
  return STATUS.ok;
}

function worstLib(libraries) {
  return libraries.reduce((worst, l) => (l.balance < worst.balance ? l : worst), libraries[0]);
}

function totalOutstanding(libraries) {
  return libraries.reduce((sum, l) => sum + l.outstanding, 0);
}

function isBlocked(user) {
  return user.libraries.some((lib) => lib.balance <= 0);
}

const STAT_TILES = {
  all: {
    label: 'usuarios',
    tone: 'from-sky-500/25 via-sky-500/10 to-bg-800 border-sky-400/30 text-sky-100',
    icon: 'bg-sky-400/20 text-sky-100',
  },
  pending: {
    label: 'sin ver',
    tone: 'from-amber-400/25 via-amber-500/10 to-bg-800 border-amber-300/30 text-amber-100',
    icon: 'bg-amber-300/20 text-amber-100',
  },
  blocked: {
    label: 'sin saldo',
    tone: 'from-accent-500/30 via-accent-500/10 to-bg-800 border-accent-400/40 text-red-100',
    icon: 'bg-accent-400/20 text-red-100',
  },
  approved7d: {
    label: 'aprobadas · 7d',
    tone: 'from-emerald-400/25 via-emerald-500/10 to-bg-800 border-emerald-300/30 text-emerald-100',
    icon: 'bg-emerald-300/20 text-emerald-100',
  },
  blocked7d: {
    label: 'sin cupo · 7d',
    tone: 'from-fuchsia-400/25 via-fuchsia-500/10 to-bg-800 border-fuchsia-300/30 text-fuchsia-100',
    icon: 'bg-fuchsia-300/20 text-fuchsia-100',
  },
};

function StatTile({ label, value, Icon, tone, iconTone, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`card px-4 py-3 flex items-center gap-3 min-w-0 text-left bg-gradient-to-br transition-all hover:-translate-y-0.5 hover:border-white/20 ${tone} ${active ? 'ring-2 ring-white/30' : ''}`}
    >
      <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${iconTone}`}>
        <Icon className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-bold tabular-nums leading-tight">{value}</div>
        <div className="text-[11px] uppercase tracking-wider text-current/70 truncate">{label}</div>
      </div>
    </button>
  );
}

// Anillo tipo gauge (el mismo motivo que el logo) alrededor del avatar:
// fracción de saldo restante de la peor biblioteca, con su color de estado.
function BalanceRing({ balance, limit, children }) {
  const frac = limit > 0 ? Math.max(0, Math.min(1, balance / limit)) : 0;
  const color = statusOf(balance).ring;
  // Con saldo 0 el anillo va rojo completo — vacío-gris no gritaría "agotado".
  const deg = balance <= 0 ? 360 : Math.round(frac * 360);
  return (
    <div
      className="w-12 h-12 rounded-full p-[3px] flex-shrink-0"
      style={{ background: `conic-gradient(${color} ${deg}deg, #2b364e ${deg}deg)` }}
    >
      <div className="w-full h-full rounded-full overflow-hidden bg-bg-800 flex items-center justify-center">
        {children}
      </div>
    </div>
  );
}

function QuotaBar({ balance, limit }) {
  const pct = limit > 0 ? Math.round((balance / limit) * 100) : 0;
  return (
    <div className="h-2 rounded-full bg-bg-600/70 overflow-hidden" title={`${balance} de ${limit}`}>
      <div
        className={`h-full rounded-full transition-all ${statusOf(balance).bar}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// Rueda de % de avance sobre la carátula (issue #7): cuánto lleva visto el
// solicitante (películas: % de la reproducción; series: % de episodios de la
// temporada). Color según cercanía al umbral de "visto" (~85% en Tautulli):
// rojo lejos, ámbar a medias, verde a punto de liberar cupo. Se oculta al pasar
// el ratón para no tapar el ✕ de quitar del cupo.
function WatchProgressRing({ percent }) {
  const color = percent >= 70 ? '#4ade80' : percent >= 35 ? '#facc15' : '#f87171';
  const deg = Math.round((Math.min(percent, 100) / 100) * 360);
  return (
    <span
      className="absolute top-1 right-1 w-6 h-6 rounded-full p-[2px] pointer-events-none group-hover:opacity-0 transition-opacity"
      style={{ background: `conic-gradient(${color} ${deg}deg, rgba(15,20,32,.7) ${deg}deg)` }}
    >
      <span className="w-full h-full rounded-full bg-black/80 flex items-center justify-center text-[8px] font-bold tabular-nums text-gray-100">
        {percent}
      </span>
    </span>
  );
}

// Póster grande con el título en overlay sobre gradiente, estilo Seerr. Al
// pulsarlo se abre la ventana de detalle (issue #6) — los enlaces a Tautulli y
// Seerr viven ahí dentro; el ✕ (al pasar el ratón) la quita del cupo.
// Una película aún no disponible en Plex (según Seerr) se enseña apagada y
// con etiqueta: sigue pendiente pero no resta cupo hasta que se descargue.
// Issue #16: un pendiente de aprobación en Seerr se enseña igual de apagado con
// "Pdte. Aprobar" — no resta cupo y no se puede quitar (no hay fila que anular).
function PendingPoster({ item, onDetail, onDismiss }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onDetail(item)}
      onKeyDown={(e) => e.key === 'Enter' && onDetail(item)}
      className="relative block w-16 h-24 rounded-lg overflow-hidden shadow-card group flex-shrink-0 cursor-pointer"
      title={
        item.pendingApproval
          ? `${item.title ?? ''} — pendiente de aprobación en Seerr`
          : item.unavailable
          ? `${item.title ?? ''} — aún no disponible en Plex, no resta cupo`
          : `${item.title ?? ''}${(item.watchedPercent ?? 0) > 0 ? ` — ${item.watchedPercent}% visto` : ''}`
      }
    >
      {item.posterUrl ? (
        <img
          src={item.posterUrl}
          alt=""
          loading="lazy"
          className={`w-full h-full object-cover transition-transform duration-300 group-hover:scale-110 ${item.unavailable || item.pendingApproval ? 'grayscale opacity-60' : ''}`}
        />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-bg-600 to-bg-700 flex items-center justify-center text-xl">🎬</div>
      )}
      {item.pendingApproval && (
        <span className="absolute top-1 left-1 rounded bg-black/75 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-gray-300 pointer-events-none">
          Pdte. Aprobar
        </span>
      )}
      {item.unavailable && (
        <span className="absolute top-1 left-1 rounded bg-black/75 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-amber-300 pointer-events-none">
          no cuenta
        </span>
      )}
      {!item.unavailable && (item.watchedPercent ?? 0) > 0 && (
        <WatchProgressRing percent={item.watchedPercent} />
      )}
      {/* Issue #8: episodios vistos/totales de la temporada, bajo la rueda. */}
      {!item.unavailable && item.mediaType === 'tv' && item.episodesTotal != null && (
        <span className="absolute top-8 right-1 rounded bg-black/75 px-1 py-0.5 text-[8px] font-semibold tabular-nums text-gray-200 pointer-events-none group-hover:opacity-0 transition-opacity">
          {item.episodesWatched ?? 0}/{item.episodesTotal}
        </span>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-6 pb-1 px-1.5 pointer-events-none">
        <span className="block text-[9px] leading-tight text-gray-100 font-medium line-clamp-2">
          {item.title ?? '—'}
        </span>
      </div>
      {!item.pendingApproval && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss(item);
          }}
          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-gray-200 hover:bg-accent-500 hover:text-white text-[11px] leading-none hidden group-hover:flex items-center justify-center"
          title="Quitar del cupo"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

function daysAgo(ms) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'hoy';
  return days === 1 ? 'hace 1 día' : `hace ${days} días`;
}

// Issue #10: cuánto falta para que un pendiente caduque y salga del cupo.
function daysLeft(ms) {
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days <= 0) return 'hoy';
  return days === 1 ? 'queda 1 día' : `quedan ${days} días`;
}

function percentColor(percent) {
  return percent >= 70 ? 'text-green-400' : percent >= 35 ? 'text-yellow-400' : 'text-accent-400';
}

// Ventana de detalle de un pendiente (issue #6): fecha de solicitud/aprobación,
// días transcurridos, quién lo ha visto (todas las cuentas, no solo el
// solicitante) y hasta qué %, enlaces a Tautulli/Seerr y quitar del cupo.
function PendingDetailModal({ user, lib, item, statsBase, onClose, onDismiss, onDecline, onApprove }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(false);
  // Issue #8: usuario desplegado en la tabla de visualizaciones (series) para
  // ver sus episodios uno a uno.
  const [openWatcher, setOpenWatcher] = useState(null);
  const isTv = item.mediaType === 'tv';

  useEffect(() => {
    // Issue #16: un pendiente de aprobación no tiene fila aprobada ni visionados
    // que consultar — la fecha de solicitud ya viene de Seerr en el propio item.
    if (item.pendingApproval) {
      setDetail({ requestedAt: null, watchers: [] });
      return;
    }
    api
      .pendingDetail(user.userId, lib.libraryId, {
        tmdbId: item.tmdbId,
        seasonNumber: item.seasonNumber,
        title: item.title,
        ratingKey: item.ratingKey,
        mediaType: item.mediaType,
        episodesTotal: item.episodesTotal,
      })
      .then(setDetail)
      .catch(() => setError(true));
  }, []);

  // created_at de SQLite es "YYYY-MM-DD HH:MM:SS" en UTC; el createdAt de Seerr
  // (pendientes de aprobación, issue #16) ya es ISO.
  const requestedAtMs = item.pendingApproval
    ? (item.requestedAt ? Date.parse(item.requestedAt) : null)
    : detail?.requestedAt ? Date.parse(detail.requestedAt.replace(' ', 'T') + 'Z') : null;
  const lastWatchMs = detail?.watchers?.reduce((max, w) => Math.max(max, w.lastWatchedAt ?? 0), 0) || null;
  const tautulliUrl = statsBase && item.ratingKey ? `${statsBase}/info?rating_key=${item.ratingKey}` : null;

  return (
    // dvh y no vh: en Android/iOS la barra de URL del navegador come parte del
    // viewport y con 90vh el pie del modal (botones) quedaba cortado.
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div
        className="card w-full max-w-lg max-h-[85vh] overflow-y-auto p-4 sm:p-5"
        style={{ maxHeight: '85dvh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3 sm:gap-4">
          <div className="w-20 h-[7.5rem] sm:w-24 sm:h-36 rounded-lg overflow-hidden bg-bg-600 flex-shrink-0">
            {item.posterUrl ? (
              <img src={item.posterUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-2xl">🎬</div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-lg leading-tight">{item.title ?? '—'}</h3>
              <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-xl leading-none">✕</button>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {lib.libraryName} · solicitado por {user.username}
            </div>
            {item.unavailable && (
              <div className="text-xs text-amber-300 mt-1">Aún no disponible en Plex — no resta cupo.</div>
            )}
            {item.pendingApproval && (
              <div className="text-xs text-gray-400 mt-1">Pendiente de aprobación en Seerr — no resta cupo.</div>
            )}
            <dl className="mt-3 space-y-1.5 text-xs sm:text-sm">
              <div className="flex gap-2">
                <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Solicitada</dt>
                <dd>{requestedAtMs ? `${fmtDate(requestedAtMs)} · ${daysAgo(requestedAtMs)}` : detail ? 'sin registro' : '…'}</dd>
              </div>
              {/* Issue #14: desde cuándo se puede ver en Plex (según Seerr). */}
              {item.availableSince != null && (
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Disponible</dt>
                  <dd>{fmtDate(item.availableSince)} · {daysAgo(item.availableSince)}</dd>
                </div>
              )}
              {/* Issue #16: saldo cacheado del solicitante, para decidir a mano. */}
              {item.pendingApproval && item.balance != null && (
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Saldo</dt>
                  <dd className="tabular-nums">{item.balance} / {item.limit}</dd>
                </div>
              )}
              {!item.pendingApproval && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Últ. visionado</dt>
                <dd>{detail ? (lastWatchMs ? `${fmtDate(lastWatchMs)} · ${daysAgo(lastWatchMs)}` : 'nadie la ha empezado') : '…'}</dd>
              </div>
              )}
              {item.expiresAt != null && (
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Caduca</dt>
                  <dd>
                    {fmtDate(item.expiresAt)} · {daysLeft(item.expiresAt)}
                    <span className="text-gray-500"> — al caducar deja de restar cupo</span>
                  </dd>
                </div>
              )}
              {!item.pendingApproval && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Avance</dt>
                <dd className={`font-bold tabular-nums ${percentColor(item.watchedPercent ?? 0)}`}>
                  {item.watchedPercent ?? 0}%
                  {isTv && item.episodesTotal != null && (
                    <span className="text-gray-400 font-normal"> · {item.episodesWatched ?? 0}/{item.episodesTotal} ep.</span>
                  )}
                  <span className="text-gray-500 font-normal"> del solicitante</span>
                </dd>
              </div>
              )}
            </dl>
          </div>
        </div>

        <div className="mt-4">
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Visualizaciones</div>
          {error && <p className="text-sm text-accent-400">No se pudo cargar el detalle.</p>}
          {!error && !detail && <p className="text-sm text-gray-500">Cargando…</p>}
          {detail && detail.watchers.length === 0 && (
            <p className="text-sm text-gray-500">
              {item.ratingKey ? 'Sin reproducciones registradas en Tautulli.' : 'Todavía no está en Plex — sin datos de visionado.'}
            </p>
          )}
          {detail && detail.watchers.length > 0 && (
            // overflow-x-auto: en pantallas estrechas la tabla scrollea dentro
            // del modal en vez de aplastar las columnas o desbordar la página.
            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="font-normal pb-1 pr-3">Usuario</th>
                    <th className="font-normal pb-1 pr-3 text-right">{isTv ? 'Vistos' : 'Veces'}</th>
                    <th className="font-normal pb-1 pr-3 text-right whitespace-nowrap">Últ. visionado</th>
                    <th className="font-normal pb-1 text-right">%</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.watchers.map((w) => (
                    // En series la fila se puede desplegar para ver el % de
                    // cada episodio reproducido (issue #8).
                    <Fragment key={w.userId}>
                      <tr
                        className={`border-t border-bg-700 ${isTv && w.episodes?.length > 0 ? 'cursor-pointer hover:bg-bg-700/40' : ''}`}
                        onClick={() => isTv && w.episodes?.length > 0 && setOpenWatcher(openWatcher === w.userId ? null : w.userId)}
                      >
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          {isTv && w.episodes?.length > 0 && (
                            <span className="text-gray-500 mr-1 text-[9px]">{openWatcher === w.userId ? '▼' : '▶'}</span>
                          )}
                          {w.username}
                          {w.userId === user.userId && (
                            <span className="ml-1.5 text-[9px] uppercase tracking-wide text-accent-400">solicitante</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {isTv ? `${w.episodesWatched ?? 0}${w.episodesTotal ? `/${w.episodesTotal}` : ''}` : w.plays}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-gray-400 whitespace-nowrap">
                          {w.lastWatchedAt ? daysAgo(w.lastWatchedAt) : '—'}
                        </td>
                        <td className={`py-1.5 text-right font-bold tabular-nums ${percentColor(w.maxPercent)}`}>
                          {w.maxPercent}%
                        </td>
                      </tr>
                      {isTv && openWatcher === w.userId &&
                        w.episodes.map((ep) => (
                          <tr key={`${w.userId}-ep${ep.episodeNumber}`} className="text-gray-400">
                            <td className="py-1 pr-3 pl-5 whitespace-nowrap truncate max-w-40" colSpan={2}>
                              <span className="tabular-nums text-gray-500">{item.seasonNumber ?? '?'}x{String(ep.episodeNumber).padStart(2, '0')}</span>
                              {ep.title && <span className="ml-1.5">{ep.title}</span>}
                            </td>
                            <td />
                            <td className={`py-1 text-right tabular-nums ${percentColor(ep.percent)}`}>{ep.percent}%</td>
                          </tr>
                        ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 mt-5">
          {tautulliUrl && (
            <a href={tautulliUrl} target="_blank" rel="noreferrer" className="btn btn-ghost">Ver en Tautulli</a>
          )}
          {detail?.seerrUrl && (
            <a href={detail.seerrUrl} target="_blank" rel="noreferrer" className="btn btn-ghost">Ver en Seerr</a>
          )}
          {/* Issue #16: un pendiente de aprobación se decide aquí mismo; no hay
              fila de cupo que quitar. */}
          {item.pendingApproval ? (
            <>
              <button onClick={() => onApprove(item)} className="btn btn-primary ml-auto">
                Aprobar
              </button>
              <button onClick={() => onDecline(item)} className="btn btn-ghost text-accent-400">
                Rechazar
              </button>
            </>
          ) : (
            <>
              {/* Issue #11: un pendiente que aún no está en Plex se puede rechazar
                  directamente en Seerr (cancela la descarga y anula la fila). */}
              {item.unavailable && item.requestId != null && (
                <button onClick={() => onDecline(item)} className="btn btn-ghost text-accent-400">
                  Rechazar en Seerr
                </button>
              )}
              <button onClick={() => onDismiss(item)} className="btn btn-ghost text-accent-400 ml-auto">
                Quitar del cupo
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Issue #11: solicitudes que siguen sin aprobar en Seerr, agrupadas por
// biblioteca, con aprobar/rechazar directos. Desde el issue #16 aquí solo
// llegan las que no tienen tarjeta de usuario donde colgarse (usuario sin
// match, sin biblioteca o sin cupo calculado); el resto sale en su tarjeta.
function PendingApprovals({ items, onAction }) {
  const [acting, setActing] = useState({});
  if (items.length === 0) return null;

  const byLibrary = new Map();
  for (const item of items) {
    const key = item.libraryName ?? 'Sin biblioteca configurada';
    if (!byLibrary.has(key)) byLibrary.set(key, []);
    byLibrary.get(key).push(item);
  }

  async function act(item, action) {
    const label = action === 'approve' ? 'Aprobar' : 'Rechazar';
    if (!confirm(`¿${label} "${item.title ?? 'esta solicitud'}" de ${item.username} en Seerr?`)) return;
    setActing((a) => ({ ...a, [item.requestId]: action }));
    try {
      if (action === 'approve') await api.approveRequest(item.requestId);
      else await api.declineRequest(item.requestId);
    } finally {
      setActing((a) => ({ ...a, [item.requestId]: null }));
      onAction();
    }
  }

  return (
    <div className="card p-4 mb-6 border-amber-400/30">
      <h3 className="font-semibold mb-1">Pendientes de aprobación</h3>
      <p className="text-xs text-gray-500 mb-3">
        Solicitudes esperando en Seerr sin usuario reconocido — las de usuarios conocidos salen en su tarjeta.
      </p>
      {[...byLibrary.entries()].map(([libraryName, libItems]) => (
        <div key={libraryName} className="mb-3 last:mb-0">
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">{libraryName}</div>
          <div className="space-y-2">
            {libItems.map((item) => (
              <div key={item.requestId} className="flex items-center gap-3 text-sm">
                <span className="w-8 h-12 rounded overflow-hidden bg-bg-600 flex-shrink-0">
                  {item.posterUrl && <img src={item.posterUrl} alt="" loading="lazy" className="w-full h-full object-cover" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{item.title ?? `solicitud #${item.requestId}`}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {item.username}
                    {item.balance != null && ` · saldo ${item.balance}/${item.limit}`}
                    {item.seasons.length > 1 && ` · ${item.seasons.length} temporadas`}
                  </div>
                </div>
                <button
                  onClick={() => act(item, 'approve')}
                  disabled={Boolean(acting[item.requestId])}
                  className="btn btn-primary py-1 px-2.5 text-xs"
                >
                  {acting[item.requestId] === 'approve' ? 'Aprobando…' : 'Aprobar'}
                </button>
                <button
                  onClick={() => act(item, 'decline')}
                  disabled={Boolean(acting[item.requestId])}
                  className="btn btn-ghost py-1 px-2.5 text-xs text-accent-400"
                >
                  {acting[item.requestId] === 'decline' ? 'Rechazando…' : 'Rechazar'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Burbujas de "deudores" estilo Tricount: todos los usuarios con pendientes de
// ver, en círculos cuyo tamaño es proporcional a lo que deben (el que más debe
// marca la escala). El anillo marca el déficit (pendiente / pedido histórico).
// Tiemblan sutilmente al tocarlas y al pulsar una se despliega el detalle de lo
// que debe; cada línea abre la ventana de detalle normal.
function DebtorBubble({ debtor, size, lead, open, onToggle }) {
  const [wobble, setWobble] = useState(false);
  const { user, owed, requested, ratio } = debtor;
  const deg = Math.round(ratio * 360);
  const showName = size >= 88;

  return (
    <button
      type="button"
      onPointerDown={() => setWobble(true)}
      onAnimationEnd={() => setWobble(false)}
      onClick={onToggle}
      title={`${user.username} debe ${owed} de ${requested} pedidas (${Math.round(ratio * 100)}%)`}
      className={`rounded-full p-[4px] select-none transition-transform hover:scale-[1.03] active:scale-[0.97] ${lead ? 'shadow-glow' : ''} ${wobble ? 'animate-debtor-wobble' : ''} ${open ? 'ring-2 ring-accent-400 ring-offset-2 ring-offset-bg-900' : ''}`}
      style={{
        width: size,
        height: size,
        background: `conic-gradient(#ef4444 ${deg}deg, #34445f ${deg}deg)`,
      }}
    >
      <div className="w-full h-full rounded-full bg-bg-800 flex flex-col items-center justify-center gap-0.5 overflow-hidden px-1.5">
        <span className="rounded-full overflow-hidden bg-bg-600 flex items-center justify-center" style={{ width: size * 0.38, height: size * 0.38 }}>
          {user.isGroup ? (
            <IconUsers className="w-1/2 h-1/2 text-gray-300" />
          ) : user.avatar ? (
            <img src={user.avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className={`${showName ? 'text-sm' : 'text-[10px]'} font-bold`}>{user.username.slice(0, 2).toUpperCase()}</span>
          )}
        </span>
        {showName && (
          <span className="text-xs font-bold text-white leading-tight truncate max-w-full">{user.username}</span>
        )}
        <span className={`${showName ? 'text-[10px]' : 'text-[9px]'} text-accent-300 font-semibold tabular-nums leading-none`}>
          debe {owed}
        </span>
      </div>
    </button>
  );
}

function DebtorBubbles({ debtors, onDetail }) {
  const [openId, setOpenId] = useState(null);
  const open = debtors.find((d) => d.user.userId === openId) ?? null;
  const maxOwed = debtors[0].owed;

  return (
    <div className="flex flex-col items-center mb-6">
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3 max-w-2xl">
        {debtors.map((d, i) => (
          <DebtorBubble
            key={d.user.userId}
            debtor={d}
            lead={i === 0}
            // 56–160 px: el mayor deudor marca la escala, el resto en proporción.
            size={Math.round(56 + (d.owed / maxOwed) * 104)}
            open={openId === d.user.userId}
            onToggle={() => setOpenId((id) => (id === d.user.userId ? null : d.user.userId))}
          />
        ))}
      </div>
      <div className="text-[11px] text-gray-500 mt-2">
        Mayor déficit: {debtors[0].user.username} · {debtors[0].owed} sin ver de {debtors[0].requested} pedidas · {Math.round(debtors[0].ratio * 100)}%
      </div>

      {open && (
        <div className="card w-full max-w-md mt-3 p-4">
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Lo que debe {open.user.username}</div>
          <div className="space-y-2">
            {open.user.libraries.flatMap((lib) =>
              (lib.pendingItems ?? [])
                // Un pendiente de aprobación (issue #16) aún no es deuda.
                .filter((item) => !item.unavailable && !item.pendingApproval)
                .map((item, i) => (
                  <button
                    key={`${lib.libraryId}-${item.tmdbId ?? 'x'}-${item.seasonNumber ?? 0}-${i}`}
                    type="button"
                    onClick={() => onDetail(open.user, lib, item)}
                    className="w-full flex items-center gap-3 text-sm text-left hover:bg-bg-700/40 rounded-lg p-1 -m-1 transition-colors"
                  >
                    <span className="w-8 h-12 rounded overflow-hidden bg-bg-600 flex-shrink-0">
                      {item.posterUrl && <img src={item.posterUrl} alt="" loading="lazy" className="w-full h-full object-cover" />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate font-medium">{item.title ?? '—'}</span>
                      <span className="block text-xs text-gray-500 truncate">{lib.libraryName}</span>
                    </span>
                    <span className={`font-bold tabular-nums text-xs ${percentColor(item.watchedPercent ?? 0)}`}>
                      {item.watchedPercent ?? 0}%
                    </span>
                  </button>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Pila de mini-carátulas solapadas para la cabecera plegada de la tarjeta.
function PosterStack({ libraries }) {
  const items = libraries.flatMap((l) => (l.pendingItems ?? []).filter((it) => !it.pendingApproval)).slice(0, 3);
  if (items.length === 0) return null;
  return (
    <div className="hidden sm:flex -space-x-2.5 flex-shrink-0">
      {items.map((item, i) => (
        <span key={i} className="w-7 h-10 rounded overflow-hidden ring-2 ring-bg-800 bg-bg-600" style={{ zIndex: 3 - i }}>
          {item.posterUrl && <img src={item.posterUrl} alt="" loading="lazy" className="w-full h-full object-cover" />}
        </span>
      ))}
    </div>
  );
}

function UserCard({ user, expanded, onToggle, onReset, onDismiss, onDetail, resetting }) {
  const worst = worstLib(user.libraries);
  const pending = totalOutstanding(user.libraries);
  return (
    <div className="card overflow-hidden hover:border-bg-600/80 transition-colors">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-bg-700/40 transition-colors"
      >
        <BalanceRing balance={worst.balance} limit={worst.limitApplied}>
          {user.isGroup ? (
            <IconUsers className="w-5 h-5 text-gray-300" />
          ) : user.avatar ? (
            <img src={user.avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="text-xs font-bold">{user.username.slice(0, 2).toUpperCase()}</span>
          )}
        </BalanceRing>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">
            {user.username}
            {user.isGroup && (
              <span className="ml-1.5 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent-600/20 text-accent-300 ring-1 ring-accent-500/40 align-middle">
                grupo
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {user.isGroup && user.members?.length > 0
              ? user.members.join(', ')
              : `${pending === 0 ? 'sin pendientes' : `${pending} pendiente(s)`} · ${user.libraries.length} biblioteca(s)`}
          </div>
        </div>
        <PosterStack libraries={user.libraries} />
        <span className={`text-xl font-bold tabular-nums ${statusOf(worst.balance).text}`}>{worst.balance}</span>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-700 p-4 space-y-4 bg-bg-900/30">
          {user.libraries.map((lib) => {
            const key = `${user.userId}-${lib.libraryId}`;
            return (
              <div key={key}>
                <div className="flex items-center gap-3 text-sm mb-1.5">
                  <span className="flex-1 truncate font-medium">{lib.libraryName}</span>
                  <span className="text-gray-400 tabular-nums">
                    <span className={`font-bold ${statusOf(lib.balance).text}`}>{lib.balance}</span>
                    {' '}/ {lib.limitApplied}
                  </span>
                  <button
                    onClick={() => onReset(user.userId, lib.libraryId)}
                    disabled={resetting[key]}
                    className="text-accent-400 hover:text-accent-300 text-xs disabled:opacity-50"
                  >
                    {resetting[key] ? 'reseteando…' : 'resetear'}
                  </button>
                </div>
                <QuotaBar balance={lib.balance} limit={lib.limitApplied} />
                {lib.pendingItems?.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {lib.pendingItems.map((item, i) => (
                      <PendingPoster
                        key={`${item.tmdbId ?? 'x'}-${item.seasonNumber ?? 0}-${i}`}
                        item={item}
                        onDetail={(it) => onDetail(user, lib, it)}
                        onDismiss={(it) => onDismiss(user.userId, lib.libraryId, it)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Quota() {
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [query, setQuery] = useState('');
  const [recalculating, setRecalculating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [resetting, setResetting] = useState({});
  const [expanded, setExpanded] = useState(new Set());
  const [activeFilter, setActiveFilter] = useState('all');
  // Pendiente abierto en la ventana de detalle: { user, lib, item } o null.
  const [detailTarget, setDetailTarget] = useState(null);
  // Base para enlazar pósters con Tautulli: la URL pública si está configurada
  // (la interna suele ser un hostname docker que el navegador no resuelve).
  const [statsBase, setStatsBase] = useState('');

  function load() {
    api.quota().then(setUsers);
    api.stats().then(setStats);
    api.pendingApprovals().then(setPendingApprovals).catch(() => {});
  }

  useEffect(() => {
    load();
    api.settings().then((s) => setStatsBase(s.tautulli_public_url || s.tautulli_url || ''));
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // Issue #16: un pendiente de aprobación con usuario y biblioteca conocidos se
  // cuelga de la tarjeta de ese usuario (gris, "Pdte. Aprobar", no resta cupo);
  // en el banner de arriba quedan solo los que no tienen tarjeta donde salir
  // (usuario sin match en Tautulli, sin biblioteca o aún sin cupo calculado).
  const { mergedUsers, unmatchedApprovals } = useMemo(() => {
    const cardKeys = new Set(users.flatMap((u) => u.libraries.map((l) => `${u.userId}-${l.libraryId}`)));
    const byCard = new Map();
    const unmatched = [];
    for (const pa of pendingApprovals) {
      const key = pa.cacheUserId != null && pa.libraryId != null ? `${pa.cacheUserId}-${pa.libraryId}` : null;
      if (!key || !cardKeys.has(key)) {
        unmatched.push(pa);
        continue;
      }
      if (!byCard.has(key)) byCard.set(key, []);
      byCard.get(key).push({
        title: pa.title,
        mediaType: pa.mediaType || 'movie',
        tmdbId: pa.tmdbId,
        seasonNumber: pa.seasons?.[0] ?? null,
        posterUrl: pa.posterUrl,
        pendingApproval: true,
        requestId: pa.requestId,
        requestedAt: pa.requestedAt,
        balance: pa.balance,
        limit: pa.limit,
      });
    }
    if (byCard.size === 0) return { mergedUsers: users, unmatchedApprovals: unmatched };
    const merged = users.map((u) => ({
      ...u,
      libraries: u.libraries.map((lib) => {
        const extra = byCard.get(`${u.userId}-${lib.libraryId}`);
        return extra ? { ...lib, pendingItems: [...(lib.pendingItems ?? []), ...extra] } : lib;
      }),
    }));
    return { mergedUsers: merged, unmatchedApprovals: unmatched };
  }, [users, pendingApprovals]);

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mergedUsers
      .filter((u) => !q || u.username.toLowerCase().includes(q))
      .filter((u) => {
        if (activeFilter === 'pending') return totalOutstanding(u.libraries) > 0;
        if (activeFilter === 'blocked') return isBlocked(u);
        if (activeFilter === 'approved7d') return (u.approved7d ?? 0) > 0;
        if (activeFilter === 'blocked7d') return (u.blocked7d ?? 0) > 0;
        return true;
      })
      .sort((a, b) => worstLib(a.libraries).balance - worstLib(b.libraries).balance);
  }, [mergedUsers, query, activeFilter]);

  // Deudores para las burbujas: los 4 con más pendientes de ver, de más a
  // menos deuda (a igualdad, peor proporción sin ver / pedido primero).
  // ratio ∈ (0,1] dimensiona el anillo (requested puede quedarse corto si el
  // historial no está importado — se acota con el propio owed para no pasar de 1).
  const debtors = useMemo(() => {
    return mergedUsers
      .map((u) => {
        const owed = totalOutstanding(u.libraries);
        const requested = Math.max(u.requestedTotal ?? 0, owed);
        return { user: u, owed, requested, ratio: owed > 0 ? owed / requested : 0 };
      })
      .filter((d) => d.owed > 0)
      .sort((a, b) => b.owed - a.owed || b.ratio - a.ratio)
      .slice(0, 4);
  }, [mergedUsers]);

  function selectFilter(filter) {
    setActiveFilter((current) => (current === filter && filter !== 'all' ? 'all' : filter));
  }

  async function recalculate() {
    setRecalculating(true);
    await api.recalculateQuota();
    load();
    setRecalculating(false);
  }

  async function importHistory() {
    setImporting(true);
    setImportResult(null);
    const { imported } = await api.importSeerrHistory();
    await api.recalculateQuota();
    load();
    setImportResult(`${imported} solicitud(es) importada(s)`);
    setImporting(false);
  }

  async function reset(userId, libraryId) {
    const key = `${userId}-${libraryId}`;
    setResetting((r) => ({ ...r, [key]: true }));
    await api.resetQuota(userId, libraryId);
    load();
    setResetting((r) => ({ ...r, [key]: false }));
  }

  async function dismiss(userId, libraryId, item) {
    if (!confirm(`¿Quitar "${item.title ?? 'este pendiente'}" del cupo?`)) return false;
    await api.dismissPending(userId, libraryId, {
      tmdbId: item.tmdbId,
      seasonNumber: item.seasonNumber ?? null,
      title: item.title,
    });
    load();
    return true;
  }

  function toggle(userId) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="page-title">Cupo por usuario</h2>
          <p className="text-sm text-gray-500 mt-1">
            Saldo = límite − pendientes de ver. Se refresca solo cada minuto.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {importResult && <span className="text-xs text-gray-500">{importResult}</span>}
          <button onClick={importHistory} disabled={importing} className="btn btn-ghost">
            {importing ? 'Importando…' : 'Importar historial de Seerr'}
          </button>
          <button onClick={recalculate} disabled={recalculating} className="btn btn-ghost">
            {recalculating ? 'Recalculando…' : 'Recalcular todos'}
          </button>
        </div>
      </div>

      {debtors.length > 0 && <DebtorBubbles debtors={debtors} onDetail={(user, lib, item) => setDetailTarget({ user, lib, item })} />}

      <PendingApprovals items={unmatchedApprovals} onAction={load} />

      {stats && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
            <StatTile
              label={STAT_TILES.all.label}
              value={stats.users}
              Icon={IconUsers}
              tone={STAT_TILES.all.tone}
              iconTone={STAT_TILES.all.icon}
              active={activeFilter === 'all'}
              onClick={() => selectFilter('all')}
            />
            <StatTile
              label={STAT_TILES.pending.label}
              value={stats.outstanding}
              Icon={IconEye}
              tone={STAT_TILES.pending.tone}
              iconTone={STAT_TILES.pending.icon}
              active={activeFilter === 'pending'}
              onClick={() => selectFilter('pending')}
            />
            <StatTile
              label={STAT_TILES.blocked.label}
              value={stats.usersBlocked}
              Icon={IconBan}
              tone={STAT_TILES.blocked.tone}
              iconTone={STAT_TILES.blocked.icon}
              active={activeFilter === 'blocked'}
              onClick={() => selectFilter('blocked')}
            />
            <StatTile
              label={STAT_TILES.approved7d.label}
              value={stats.approved7d}
              Icon={IconCheckCircle}
              tone={STAT_TILES.approved7d.tone}
              iconTone={STAT_TILES.approved7d.icon}
              active={activeFilter === 'approved7d'}
              onClick={() => selectFilter('approved7d')}
            />
            <StatTile
              label={STAT_TILES.blocked7d.label}
              value={stats.blocked7d}
              Icon={IconXCircle}
              tone={STAT_TILES.blocked7d.tone}
              iconTone={STAT_TILES.blocked7d.icon}
              active={activeFilter === 'blocked7d'}
              onClick={() => selectFilter('blocked7d')}
            />
          </div>
          {activeFilter !== 'all' && (
            <div className="mb-4">
              <button onClick={() => setActiveFilter('all')} className="text-xs text-gray-400 hover:text-gray-200">
                Mostrando {STAT_TILES[activeFilter].label.toLowerCase()} · quitar filtro
              </button>
            </div>
          )}
        </>
      )}

      <div className="relative mb-4 max-w-xs">
        <IconSearch className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar usuario…"
          className="input pl-8"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visibleUsers.map((u) => (
          <UserCard
            key={u.userId}
            user={u}
            expanded={expanded.has(u.userId)}
            onToggle={() => toggle(u.userId)}
            onReset={reset}
            onDismiss={dismiss}
            onDetail={(user, lib, item) => setDetailTarget({ user, lib, item })}
            resetting={resetting}
          />
        ))}
      </div>

      {detailTarget && (
        <PendingDetailModal
          {...detailTarget}
          statsBase={statsBase}
          onClose={() => setDetailTarget(null)}
          onDismiss={async (item) => {
            const done = await dismiss(detailTarget.user.userId, detailTarget.lib.libraryId, item);
            if (done) setDetailTarget(null);
          }}
          onDecline={async (item) => {
            if (!confirm(`¿Rechazar "${item.title ?? 'esta solicitud'}" en Seerr? Se cancela la solicitud y deja de contar.`)) return;
            await api.declineRequest(item.requestId);
            load();
            setDetailTarget(null);
          }}
          onApprove={async (item) => {
            if (!confirm(`¿Aprobar "${item.title ?? 'esta solicitud'}" en Seerr?`)) return;
            await api.approveRequest(item.requestId);
            load();
            setDetailTarget(null);
          }}
        />
      )}

      {users.length === 0 && (
        <p className="text-gray-500 text-sm py-6 text-center">
          Sin datos todavía — pulsa "Recalcular todos" o espera a que el scheduler procese solicitudes.
        </p>
      )}
      {users.length > 0 && visibleUsers.length === 0 && (
        <p className="text-gray-500 text-sm py-6 text-center">Ningún usuario coincide con "{query}".</p>
      )}
    </div>
  );
}
