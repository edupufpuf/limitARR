import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { IconSearch, IconUsers, IconEye, IconBan, IconCheckCircle, IconXCircle } from '../icons.jsx';
import { SalvadosGrid } from '../components/Salvados.jsx';
import { downloadStatusLabel, downloadStatusColor, downloadStatusBg, downloadStatusChipText } from '../mediaStatus.js';

// Recarga entera tras suplantar: la sesión (cookie) ya quedó en role='user' en
// el servidor, y App.jsx solo lee /auth/me al montar — el reload es más simple
// que subir un callback de refresco por todo Dashboard → Quota.
async function impersonate(userId, username) {
  if (!confirm(`¿Ver el panel como ${username}? Tu sesión de admin pasará a la suya hasta que pulses "Volver a admin".`)) return;
  await api.impersonate(userId);
  window.location.reload();
}

const REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;

function requestDateMs(value) {
  if (!value) return null;
  const raw = String(value);
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOlderThanTwoMonths(dateMs, now = new Date()) {
  if (dateMs == null) return false;
  const limit = new Date(dateMs);
  limit.setMonth(limit.getMonth() + 2);
  return now.getTime() >= limit.getTime();
}

function formatRequestDate(dateMs) {
  if (dateMs == null) return 'Fecha desconocida';
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid',
  }).format(new Date(dateMs));
}

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
    description: 'Usuarios de Tautulli con cupo calculado.',
    tone: 'from-sky-500/25 via-sky-500/10 to-bg-800 border-sky-400/30 text-sky-100',
    icon: 'bg-sky-400/20 text-sky-100',
  },
  pending: {
    label: 'sin ver',
    description: 'Cosas aprobadas que el usuario todavía no se ha visto (siguen ocupando cupo).',
    tone: 'from-amber-400/25 via-amber-500/10 to-bg-800 border-amber-300/30 text-amber-100',
    icon: 'bg-amber-300/20 text-amber-100',
  },
  blocked: {
    label: 'sin saldo',
    description: 'Usuarios que ahora mismo tienen el cupo a 0 en alguna biblioteca: la próxima solicitud se rechazaría.',
    tone: 'from-accent-500/30 via-accent-500/10 to-bg-800 border-accent-400/40 text-red-100',
    icon: 'bg-accent-400/20 text-red-100',
  },
  approved7d: {
    label: 'aprobadas · 7d',
    description: 'Solicitudes que limitARR aprobó automáticamente en los últimos 7 días.',
    tone: 'from-emerald-400/25 via-emerald-500/10 to-bg-800 border-emerald-300/30 text-emerald-100',
    icon: 'bg-emerald-300/20 text-emerald-100',
  },
  blocked7d: {
    label: 'sin cupo · 7d',
    description: 'Aprobaciones NO hechas en los últimos 7 días por falta de saldo (el usuario ya no tenía cupo cuando pidió esto).',
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

function PendingMoviesByAge({ users, onDetail }) {
  const [sort, setSort] = useState('oldest');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const allRows = useMemo(() => {
    const now = new Date();
    return users.flatMap((user) => user.libraries.flatMap((lib) =>
      (lib.pendingItems ?? [])
        .filter((item) => (item.mediaType || 'movie') !== 'tv')
        .map((item) => {
          const dateMs = requestDateMs(item.requestedAt);
          return {
            user,
            lib,
            item,
            dateMs,
            days: dateMs == null ? null : Math.max(0, Math.floor((now.getTime() - dateMs) / DAY_MS)),
            overdue: isOlderThanTwoMonths(dateMs, now),
          };
        })
    ));
  }, [users]);

  const rows = useMemo(() => {
    const filtered = overdueOnly ? allRows.filter((row) => row.overdue) : [...allRows];
    return filtered.sort((a, b) => {
      if (sort === 'user') {
        return a.user.username.localeCompare(b.user.username, 'es') || (a.dateMs ?? Infinity) - (b.dateMs ?? Infinity);
      }
      if (a.dateMs == null) return 1;
      if (b.dateMs == null) return -1;
      return sort === 'newest' ? b.dateMs - a.dateMs : a.dateMs - b.dateMs;
    });
  }, [allRows, sort, overdueOnly]);

  const overdue = allRows.filter((row) => row.overdue).length;

  return (
    <section className="card mb-5 overflow-hidden">
      <div className="p-4 border-b border-bg-700 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">🎬 Películas pendientes por antigüedad</h3>
          <p className="text-xs text-gray-500 mt-1">
            {allRows.length} pendiente{allRows.length === 1 ? '' : 's'} · <span className={overdue > 0 ? 'text-accent-400 font-semibold' : ''}>{overdue} con más de 2 meses</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setOverdueOnly((value) => !value)}
            className={`btn text-xs py-1.5 ${overdueOnly ? 'btn-primary' : 'btn-ghost'}`}
          >
            {overdueOnly ? 'Mostrando +2 meses' : 'Solo +2 meses'}
          </button>
          <select value={sort} onChange={(event) => setSort(event.target.value)} className="input w-auto py-1.5 text-xs">
            <option value="oldest">Más antiguas primero</option>
            <option value="newest">Más recientes primero</option>
            <option value="user">Ordenar por usuario</option>
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">
          {overdueOnly ? 'No hay películas pendientes desde hace más de dos meses.' : 'No hay películas pendientes.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-gray-500 bg-bg-900/40">
              <tr>
                <th className="text-left font-medium px-4 py-2">Película</th>
                <th className="text-left font-medium px-3 py-2">Usuario</th>
                <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Biblioteca</th>
                <th className="text-left font-medium px-3 py-2">Fecha solicitada</th>
                <th className="text-right font-medium px-4 py-2">Antigüedad</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-700/70">
              {rows.map(({ user, lib, item, dateMs, days, overdue: isOverdue }, index) => (
                <tr
                  key={`${user.userId}-${lib.libraryId}-${item.requestId ?? item.tmdbId ?? item.title}-${index}`}
                  onClick={() => onDetail(user, lib, item)}
                  className={`cursor-pointer hover:bg-bg-700/35 ${isOverdue ? 'bg-accent-500/5' : ''}`}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2 min-w-[190px]">
                      <div className="w-8 h-12 rounded bg-bg-700 overflow-hidden flex-shrink-0">
                        {item.posterUrl ? <img src={item.posterUrl} alt="" className="w-full h-full object-cover" /> : <span className="w-full h-full flex items-center justify-center">🎬</span>}
                      </div>
                      <div>
                        <div className="font-medium">{item.title}</div>
                        {item.pendingApproval && <div className="text-[11px] text-purple-300">Pendiente de aprobación</div>}
                        {item.unavailable && !item.pendingApproval && <div className="text-[11px] text-sky-300">Pendiente de descarga</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-300">{user.username}</td>
                  <td className="px-3 py-2.5 text-gray-500 hidden md:table-cell">{lib.libraryName}</td>
                  <td className="px-3 py-2.5 tabular-nums text-gray-300 whitespace-nowrap">{formatRequestDate(dateMs)}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {days == null ? (
                      <span className="text-gray-600">—</span>
                    ) : isOverdue ? (
                      <span className="inline-flex rounded-full bg-accent-500/15 text-accent-300 ring-1 ring-accent-400/30 px-2 py-1 text-xs font-semibold">{days} días · +2 meses</span>
                    ) : (
                      <span className="text-gray-400 tabular-nums">{days} días</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
          ? item.sequentialQueue
            ? `${item.title ?? ''} — pendiente de aprobar cuando se vea la temporada ${item.previousSeasonNumber ?? 'anterior'}`
            : `${item.title ?? ''} — pendiente de aprobación en Seerr`
          : item.bypassed
          ? `${item.title ?? ''} — aprobada fuera de limitARR, no resta cupo`
          : item.unavailable
          ? `${item.title ?? ''} — ${downloadStatusLabel(item)}, no resta cupo`
          : `${item.title ?? ''}${(item.watchedPercent ?? 0) > 0 ? ` — ${item.watchedPercent}% visto` : ''}${item.note ? ` — nota: ${item.note}` : ''}`
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
        <span className="absolute top-1 left-1 right-1 line-clamp-2 rounded bg-violet-600 px-1 py-0.5 text-[7px] leading-tight font-semibold uppercase tracking-wide text-white pointer-events-none">
          {item.sequentialQueue ? 'Espera t. anterior' : 'Pdte. Aprobar'}
        </span>
      )}
      {item.bypassed && !item.unavailable && (
        <span className="absolute top-1 left-1 right-1 line-clamp-2 rounded bg-violet-600 px-1 py-0.5 text-[7px] leading-tight font-semibold uppercase tracking-wide text-white pointer-events-none">
          No cuenta (aparte)
        </span>
      )}
      {item.unavailable && (
        <div className="absolute top-1 left-1 right-1 flex flex-col items-start gap-0.5 pointer-events-none">
          <span className="min-w-0 max-w-full truncate rounded bg-indigo-600 px-1 py-0.5 text-[7px] leading-none font-semibold uppercase tracking-wide text-white">
            no cuenta
          </span>
          <span className={`min-w-0 max-w-full line-clamp-2 rounded px-1 py-0.5 text-[7px] leading-tight font-semibold uppercase tracking-wide ${downloadStatusBg(item)} ${downloadStatusChipText(item)}`}>
            {downloadStatusLabel(item)}
          </span>
        </div>
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

// Pedidas y ya vistas en los últimos 30 días — grid en gris, sin acciones
// (no está en cupo, es solo historial, a diferencia de PendingPoster).
export function RecentlyWatchedPoster({ item }) {
  const watchedAtMs = item.watchedAt ? Date.parse(item.watchedAt.replace(' ', 'T') + 'Z') : null;
  return (
    <div
      className="relative w-16 h-24 rounded-lg overflow-hidden shadow-card flex-shrink-0"
      title={`${item.title ?? '—'}${item.watchedBy ? ` — vista por ${item.watchedBy}` : ''}${watchedAtMs ? ` — vista ${daysAgo(watchedAtMs)}` : ''}`}
    >
      {item.posterUrl ? (
        <img src={item.posterUrl} alt="" loading="lazy" className="w-full h-full object-cover grayscale opacity-60" />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-bg-600 to-bg-700 flex items-center justify-center text-xl grayscale opacity-60">🎬</div>
      )}
      {/* Issue #21 (jesusgarrigues): en un grupo, quién de la familia la vio —
          sin esto un cupo compartido no dice qué miembro lo liberó. */}
      {item.watchedBy && (
        <span className="absolute top-1 left-1 right-1 line-clamp-1 rounded bg-black/75 px-1 py-0.5 text-[7px] leading-tight font-semibold text-gray-200 pointer-events-none">
          {item.watchedBy}
        </span>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-6 pb-1 px-1.5 pointer-events-none">
        <span className="block text-[9px] leading-tight text-gray-300 font-medium line-clamp-2">
          {item.title ?? '—'}
        </span>
      </div>
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
export function PendingDetailModal({
  user,
  lib,
  item,
  statsBase,
  onClose,
  onDismiss,
  onDecline,
  onApprove,
  onHold,
  onClearHold,
  loadDetail,
  readOnly = false,
}) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(false);
  // Issue #8: usuario desplegado en la tabla de visualizaciones (series) para
  // ver sus episodios uno a uno.
  const [openWatcher, setOpenWatcher] = useState(null);
  const isTv = item.mediaType === 'tv';

  useEffect(() => {
    setDetail(null);
    setError(false);
    setOpenWatcher(null);
    // Issue #16: un pendiente de aprobación no tiene fila aprobada ni visionados
    // que consultar — la fecha de solicitud ya viene de Seerr en el propio item.
    if (item.pendingApproval) {
      setDetail({ requestedAt: null, watchers: [] });
      return;
    }
    const params = {
        tmdbId: item.tmdbId,
        seasonNumber: item.seasonNumber,
        title: item.title,
        ratingKey: item.ratingKey,
        mediaType: item.mediaType,
        episodesTotal: item.episodesTotal,
      };
    const request = loadDetail
      ? loadDetail(params)
      : api.pendingDetail(user.userId, lib.libraryId, params);
    request
      .then(setDetail)
      .catch(() => setError(true));
  }, [
    item.pendingApproval,
    item.tmdbId,
    item.seasonNumber,
    item.title,
    item.ratingKey,
    item.mediaType,
    item.episodesTotal,
    loadDetail,
    user.userId,
    lib.libraryId,
  ]);

  // created_at de SQLite es "YYYY-MM-DD HH:MM:SS" en UTC; el createdAt de Seerr
  // (pendientes de aprobación, issue #16) ya es ISO.
  const requestedAtMs = item.pendingApproval
    ? (item.requestedAt ? Date.parse(item.requestedAt) : null)
    : detail?.requestedAt ? Date.parse(detail.requestedAt.replace(' ', 'T') + 'Z') : null;
  const lastWatchMs = detail?.watchers?.reduce((max, w) => Math.max(max, w.lastWatchedAt ?? 0), 0) || null;
  const tautulliUrl = detail?.tautulliUrl
    ?? (statsBase && item.ratingKey ? `${statsBase}/info?rating_key=${item.ratingKey}` : null);

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
              <div className={`text-xs mt-1 ${downloadStatusColor(item)}`}>{downloadStatusLabel(item)} — no resta cupo.</div>
            )}
            {item.pendingApproval && (
              <div className="text-xs text-gray-400 mt-1">
                {item.sequentialQueue
                  ? `Pendiente de aprobar cuando se vea la temporada ${item.previousSeasonNumber ?? 'anterior'} — no resta cupo.`
                  : 'Pendiente de aprobación en Seerr — no resta cupo.'}
              </div>
            )}
            {item.holdUntil != null && (
              <div className="text-xs text-yellow-400 mt-1">
                ⏳ Aplazada hasta {fmtDate(item.holdUntil)} · {daysLeft(item.holdUntil)}
              </div>
            )}
            {item.note && (
              <div className="text-xs text-gray-400 mt-1">📝 {item.note}</div>
            )}
            <dl className="mt-3 space-y-1.5 text-xs sm:text-sm">
              <div className="flex gap-2">
                <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Solicitada</dt>
                <dd>{requestedAtMs ? <>{fmtDate(requestedAtMs)} · <span className="whitespace-nowrap">{daysAgo(requestedAtMs)}</span></> : detail ? 'sin registro' : '…'}</dd>
              </div>
              {/* Issue #14: desde cuándo se puede ver en Plex (según Seerr). */}
              {item.availableSince != null && (
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Disponible</dt>
                  <dd>{fmtDate(item.availableSince)} · <span className="whitespace-nowrap">{daysAgo(item.availableSince)}</span></dd>
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
                <dd>{detail ? (lastWatchMs ? <>{fmtDate(lastWatchMs)} · <span className="whitespace-nowrap">{daysAgo(lastWatchMs)}</span></> : 'nadie la ha empezado') : '…'}</dd>
              </div>
              )}
              {item.expiresAt != null && (
                <div className="flex gap-2">
                  <dt className="text-gray-500 w-[5.5rem] sm:w-28 flex-shrink-0">Caduca</dt>
                  <dd>
                    {fmtDate(item.expiresAt)} · <span className="whitespace-nowrap">{daysLeft(item.expiresAt)}</span>
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
                          <span className={w.userId === user.userId ? 'text-accent-400 font-semibold' : ''}>
                            {w.username}
                          </span>
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

        {/* El detalle del usuario es estrictamente informativo: sin enlaces ni
            acciones administrativas. El pie completo solo existe en admin. */}
        {!readOnly && (
          <div className="grid grid-cols-2 gap-2 mt-5 sm:flex sm:flex-wrap">
            {tautulliUrl && (
              <a href={tautulliUrl} target="_blank" rel="noreferrer" className="btn btn-ghost">Ver en Tautulli</a>
            )}
            {detail?.seerrUrl && (
              <a href={detail.seerrUrl} target="_blank" rel="noreferrer" className="btn btn-ghost">Ver en Seerr</a>
            )}
            {/* Issue #22 (jesusgarrigues): abrir la ficha directamente en Radarr/Sonarr. */}
            {detail?.arrUrl && (
              <a href={detail.arrUrl} target="_blank" rel="noreferrer" className="btn btn-ghost">
                Ver en {isTv ? 'Sonarr' : 'Radarr'}
              </a>
            )}
            {/* Issue #16: un pendiente de aprobación se decide aquí mismo; no hay
                fila de cupo que quitar. */}
            {item.pendingApproval && !item.sequentialQueue ? (
            <>
              {item.holdUntil != null ? (
                <button onClick={() => onClearHold(item)} className="btn btn-ghost sm:ml-auto">
                  Quitar aplazamiento
                </button>
              ) : (
                <button onClick={() => onHold(item)} className="btn btn-ghost sm:ml-auto">
                  Aplazar
                </button>
              )}
              <button onClick={() => onApprove(item)} className="btn btn-primary">
                Aprobar
              </button>
              <button onClick={() => onDecline(item)} className="btn btn-ghost text-accent-400">
                Rechazar
              </button>
            </>
          ) : !item.pendingApproval ? (
            <>
              {/* Issue #11: un pendiente que aún no está en Plex se puede rechazar
                  directamente en Seerr (cancela la descarga y anula la fila). */}
              {item.unavailable && item.requestId != null && (
                <button onClick={() => onDecline(item)} className="btn btn-ghost text-accent-400">
                  Rechazar en Seerr
                </button>
              )}
              <button onClick={() => onDismiss(item)} className="btn btn-ghost text-accent-400 sm:ml-auto">
                Quitar del cupo
              </button>
            </>
            ) : null}
          </div>
        )}
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

  // v2: temporizador de aprobación — acción puntual sobre ESTA solicitud (no
  // una norma general del usuario): se aplaza N días aunque tenga cupo de sobra.
  async function hold(item) {
    const days = prompt(`¿Aplazar "${item.title ?? 'esta solicitud'}" cuántos días?`, '7');
    if (!days) return;
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) return;
    setActing((a) => ({ ...a, [item.requestId]: 'hold' }));
    try {
      await api.holdRequest(item.requestId, n);
    } finally {
      setActing((a) => ({ ...a, [item.requestId]: null }));
      onAction();
    }
  }

  async function clearHold(item) {
    setActing((a) => ({ ...a, [item.requestId]: 'hold' }));
    try {
      await api.clearRequestHold(item.requestId);
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
              <div key={item.requestId ?? `queue-${item.queueId}`} className="flex items-center gap-3 text-sm">
                <span className="w-8 h-12 rounded overflow-hidden bg-bg-600 flex-shrink-0">
                  {item.posterUrl && <img src={item.posterUrl} alt="" loading="lazy" className="w-full h-full object-cover" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{item.title ?? `solicitud #${item.requestId}`}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {item.username}
                    {item.balance != null && ` · saldo ${item.balance}/${item.limit}`}
                    {item.seasons.length > 1 && ` · ${item.seasons.length} temporadas`}
                    {item.holdUntil != null && (
                      <span className="text-yellow-400"> · ⏳ aplazada, {daysLeft(item.holdUntil)}</span>
                    )}
                    {item.sequentialQueue && (
                      <span className="text-violet-400"> · espera a que se vea la temporada {item.previousSeasonNumber ?? 'anterior'}</span>
                    )}
                  </div>
                </div>
                {!item.sequentialQueue && (item.holdUntil != null ? (
                  <button
                    onClick={() => clearHold(item)}
                    disabled={Boolean(acting[item.requestId])}
                    className="btn btn-ghost py-1 px-2.5 text-xs"
                  >
                    Quitar aplazamiento
                  </button>
                ) : (
                  <button
                    onClick={() => hold(item)}
                    disabled={Boolean(acting[item.requestId])}
                    className="btn btn-ghost py-1 px-2.5 text-xs"
                  >
                    Aplazar
                  </button>
                ))}
                {!item.sequentialQueue && <button
                  onClick={() => act(item, 'approve')}
                  disabled={Boolean(acting[item.requestId])}
                  className="btn btn-primary py-1 px-2.5 text-xs"
                >
                  {acting[item.requestId] === 'approve' ? 'Aprobando…' : 'Aprobar'}
                </button>}
                {!item.sequentialQueue && <button
                  onClick={() => act(item, 'decline')}
                  disabled={Boolean(acting[item.requestId])}
                  className="btn btn-ghost py-1 px-2.5 text-xs text-accent-400"
                >
                  {acting[item.requestId] === 'decline' ? 'Rechazando…' : 'Rechazar'}
                </button>}
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

// Issue #20: historial de aprobadas del mes en curso (mismas filas que cuenta
// el contador "mensual X/Y"), por biblioteca (lib) o total (lib=null).
// `loadHistory` opcional (panel de usuario no admin, ver UserDashboard.jsx):
// pega contra /me/quota/monthly-history(-total) en vez de la ruta de admin.
export function MonthlyHistoryModal({ user, lib, libraryNameById, onClose, loadHistory }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setRows(null);
    setError(false);
    const request = loadHistory
      ? loadHistory(lib)
      : lib
        ? api.monthlyHistory(user.userId, lib.libraryId)
        : api.monthlyHistoryTotal(user.userId);
    request.then(setRows).catch(() => setError(true));
  }, [user.userId, lib?.libraryId, loadHistory]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div
        className="card w-full max-w-md max-h-[80vh] overflow-y-auto p-4 sm:p-5"
        style={{ maxHeight: '80dvh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <h3 className="font-semibold text-lg leading-tight">Cupo mensual — {user.username}</h3>
            <div className="text-xs text-gray-500 mt-0.5">{lib ? lib.libraryName : 'todas las bibliotecas'} · mes en curso</div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-xl leading-none flex-shrink-0">✕</button>
        </div>
        {error && <p className="text-sm text-accent-400">No se pudo cargar el historial.</p>}
        {!error && rows == null && <p className="text-sm text-gray-500">Cargando…</p>}
        {rows?.length === 0 && <p className="text-sm text-gray-500">Nada aprobado este mes todavía.</p>}
        <div className="space-y-2">
          {rows?.map((r) => (
            <div key={r.id} className="flex items-center gap-3 text-sm">
              <span className="w-8 h-12 rounded overflow-hidden bg-bg-600 flex-shrink-0">
                {r.poster_url && <img src={r.poster_url} alt="" loading="lazy" className="w-full h-full object-cover" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block truncate font-medium">
                  {r.media_title ?? '—'}
                  {r.season_number != null ? ` · T${r.season_number}` : ''}
                </span>
                <span className="block text-xs text-gray-500 truncate">
                  {!lib ? (libraryNameById.get(r.library_id) ?? `biblioteca #${r.library_id}`) : r.username}
                </span>
              </span>
              <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">
                {new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function UserCard({ user, salvados = [], expanded, onToggle, onReset, onDismiss, onManualCharge, onDetail, onMonthlyHistory, resetting, charging }) {
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
        <span className={`text-xl font-bold tabular-nums ${statusOf(worst.balance).text}`}>{worst.balance}</span>
        {/* Grupo agregado: sin cuenta Plex propia, no hay quién suplantar. */}
        {!user.isGroup && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); impersonate(user.userId, user.username); }}
            title={`Ver el panel como ${user.username}`}
            className="p-1.5 rounded-lg text-gray-500 hover:text-accent-300 hover:bg-bg-700/60"
          >
            <IconEye className="w-4 h-4" />
          </button>
        )}
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-700 p-4 space-y-4 bg-bg-900/30">
          {user.monthlyTotal?.enabled && (
            <button
              type="button"
              onClick={() => onMonthlyHistory(user, null)}
              title="Cupo mensual total: cosas aprobadas este mes en cualquier biblioteca — click para ver historial"
              className={`w-full flex items-center justify-between text-xs rounded-lg px-2.5 py-1.5 hover:brightness-110 ${
                user.monthlyTotal.used >= user.monthlyTotal.limit ? 'text-accent-400 bg-accent-500/10' : 'text-gray-400 bg-bg-700/40'
              }`}
            >
              <span>📅 cupo mensual total</span>
              <span className="font-bold tabular-nums">{user.monthlyTotal.used}/{user.monthlyTotal.limit}</span>
            </button>
          )}
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
                    onClick={() => onManualCharge(user.userId, lib.libraryId, user.username, lib.sectionType)}
                    disabled={charging[key]}
                    title="Restar un hueco de cupo a mano (contenido bajado/visto fuera de Seerr)"
                    className="text-gray-400 hover:text-gray-200 text-xs disabled:opacity-50"
                  >
                    {charging[key] ? 'cargando…' : 'cargo manual'}
                  </button>
                  <button
                    onClick={() => onReset(user.userId, lib.libraryId, user.username)}
                    disabled={resetting[key]}
                    className="text-accent-400 hover:text-accent-300 text-xs disabled:opacity-50"
                  >
                    {resetting[key] ? 'reseteando…' : 'resetear'}
                  </button>
                </div>
                <QuotaBar balance={lib.balance} limit={lib.limitApplied} />
                {lib.monthly?.enabled && (
                  <button
                    type="button"
                    onClick={() => onMonthlyHistory(user, lib)}
                    className={`block text-[11px] mt-1 tabular-nums hover:underline ${lib.monthly.used >= lib.monthly.limit ? 'text-accent-400' : 'text-gray-500'}`}
                    title="Cupo mensual: cosas aprobadas este mes, aunque se vean — click para ver historial"
                  >
                    mensual {lib.monthly.used}/{lib.monthly.limit}
                  </button>
                )}
                {lib.pendingItems?.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {lib.pendingItems.map((item, i) => (
                      <PendingPoster
                        key={`${item.tmdbId ?? 'x'}-${item.seasonNumber ?? 0}-${i}`}
                        item={item}
                        onDetail={(it) => onDetail(user, lib, it)}
                        onDismiss={(it) => onDismiss(user.userId, lib.libraryId, it, user.username)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {salvados.length > 0 && (
            <div>
              <div className="text-sm font-medium mb-1.5">💾 Salvadas del borrado</div>
              <SalvadosGrid items={salvados} compact />
            </div>
          )}
          {user.recentlyWatched?.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-1.5">Vistas en los últimos 30 días</div>
              <div className="flex flex-wrap gap-2">
                {user.recentlyWatched.map((item, i) => (
                  <RecentlyWatchedPoster key={`${item.tmdbId ?? 'x'}-${item.seasonNumber ?? 0}-${i}`} item={item} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Cargo manual con buscador contra Plex (vía Tautulli): para algo que ya está
// Tras quitar un pendiente del cupo (pedido de Edu, 2 ago 2026): opción de
// penalizar por no haberlo visto. "No penalizar" (onClose) es la respuesta
// negativa — solo se pide huecos/meses si de verdad va a penalizar.
function PenaltyModal({ username, title, monthlyAvailable, onClose, onSubmit }) {
  const [kind, setKind] = useState('normal');
  const [holes, setHoles] = useState(1);
  const [months, setMonths] = useState(1);
  const [saving, setSaving] = useState(false);

  async function confirmPenalty() {
    setSaving(true);
    try {
      await onSubmit({ kind, holes: Number(holes), months: Number(months) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div className="card w-full max-w-sm p-4 sm:p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-lg mb-1">¿Penalizar a {username}?</h3>
        <p className="text-xs text-gray-400 mb-4">
          No vio "{title ?? 'esto'}". Puedes reducirle el cupo una temporada por no verlo.
        </p>
        <div className="space-y-2 mb-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="radio" name="penalty-kind" checked={kind === 'normal'} onChange={() => setKind('normal')} />
            Límite normal (pendientes)
          </label>
          <label className={`flex items-center gap-2 text-sm ${monthlyAvailable ? 'cursor-pointer' : 'opacity-40'}`}>
            <input
              type="radio"
              name="penalty-kind"
              checked={kind === 'monthly'}
              onChange={() => setKind('monthly')}
              disabled={!monthlyAvailable}
            />
            Cupo mensual{!monthlyAvailable ? ' (no activado)' : ''}
          </label>
        </div>
        <div className="flex gap-3 mb-5">
          <label className="flex-1 text-xs text-gray-400">
            Huecos
            <input
              type="number"
              min="1"
              className="input mt-1 w-full"
              value={holes}
              onChange={(e) => setHoles(e.target.value)}
            />
          </label>
          <label className="flex-1 text-xs text-gray-400">
            Meses
            <input
              type="number"
              min="1"
              className="input mt-1 w-full"
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            No penalizar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirmPenalty}
            disabled={saving || !holes || !months}
          >
            {saving ? 'Aplicando…' : 'Penalizar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// en la biblioteca pero nunca se pidió en Seerr. Elegir el resultado real evita
// el problema del título a mano (si no coincide letra a letra con Tautulli, el
// visionado nunca se detecta solo, ver addManualCharge). Se deja también un
// campo de título libre por si lo buscado no aparece. Para bibliotecas de
// series (sectionType 'show') se buscan y listan TEMPORADAS sueltas, no la
// serie entera — el cupo de series se lleva por temporada.
function ManualChargeModal({ username, sectionType, onClose, onSubmit }) {
  const isTv = sectionType === 'show';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState(null); // { title, posterUrl } | null
  const [manualTitle, setManualTitle] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    setSelected(null);
    try {
      const { results } = await api.plexSearch(query.trim(), isTv ? 'tv' : 'movie');
      setResults(results);
    } finally {
      setSearching(false);
      setSearched(true);
    }
  }

  const title = selected?.title || manualTitle.trim();

  async function confirm() {
    if (!title) return;
    setSaving(true);
    await onSubmit(title, note.trim() || null, selected?.posterUrl || null);
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div
        className="card w-full max-w-md max-h-[85vh] overflow-y-auto p-4 sm:p-5"
        style={{ maxHeight: '85dvh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold text-lg mb-1">Cargo manual — {username}</h3>
        <p className="text-xs text-gray-400 mb-3">
          Para algo bajado/visto fuera de Seerr, incluidas {isTv ? 'temporadas' : 'películas'} ya disponibles en Plex que nunca se pidieron ahí.
        </p>

        <div className="flex gap-2">
          <input
            autoFocus
            className="input flex-1"
            placeholder={isTv ? 'Buscar serie en tu Plex…' : 'Buscar película en tu Plex…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <button type="button" className="btn btn-ghost" onClick={search} disabled={searching || !query.trim()}>
            {searching ? 'Buscando…' : 'Buscar'}
          </button>
        </div>

        {searched && !searching && results.length === 0 && (
          <p className="text-xs text-gray-500 mt-2">Sin resultados en Plex — usa el título a mano abajo.</p>
        )}

        {results.length > 0 && (
          <div className="flex flex-col gap-1 mt-3 max-h-52 overflow-y-auto">
            {results.map((m, i) => (
              <button
                key={`${m.title}-${i}`}
                type="button"
                onClick={() => setSelected(m)}
                className={`flex items-center gap-2 rounded-lg p-1.5 text-left hover:bg-bg-700 ${selected?.title === m.title ? 'bg-accent-600/20 ring-1 ring-accent-500' : ''}`}
              >
                <div className="w-8 h-12 rounded bg-bg-600 overflow-hidden flex-shrink-0">
                  {m.posterUrl && <img src={m.posterUrl} alt="" className="w-full h-full object-cover" />}
                </div>
                <span className="text-sm">{m.title}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-3">
          <label className="block text-xs text-gray-400 mb-1">
            {results.length > 0 ? 'O título a mano (si no está arriba)' : 'Título'}
          </label>
          <input
            className="input w-full"
            placeholder={isTv ? 'Ej: La nena - Temporada 1' : 'Título exacto de lo que se bajó/vio'}
            value={manualTitle}
            onChange={(e) => { setManualTitle(e.target.value); setSelected(null); }}
          />
        </div>

        <div className="mt-3">
          <label className="block text-xs text-gray-400 mb-1">Nota (opcional)</label>
          <textarea className="input w-full" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" onClick={confirm} disabled={!title || saving}>
            {saving ? 'Cargando…' : 'Cargar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Quota() {
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [salvados, setSalvados] = useState([]);
  const [query, setQuery] = useState('');
  const [recalculating, setRecalculating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [resetting, setResetting] = useState({});
  const [charging, setCharging] = useState({});
  const [expanded, setExpanded] = useState(new Set());
  const [activeFilter, setActiveFilter] = useState('all');
  // Orden de la lista (pedido de Edu, 3 ago 2026): 'busiest' (por defecto, el
  // de siempre) = peor saldo primero; 'quietest' = al revés; 'name' = A-Z.
  const [sortBy, setSortBy] = useState('busiest');
  // Pendiente abierto en la ventana de detalle: { user, lib, item } o null.
  const [detailTarget, setDetailTarget] = useState(null);
  // Historial de cupo mensual abierto (issue #20): { user, lib } o null; lib
  // null = cupo mensual total (todas las bibliotecas).
  const [monthlyHistoryTarget, setMonthlyHistoryTarget] = useState(null);
  // Cargo manual abierto: { userId, libraryId, username } o null.
  const [chargeModal, setChargeModal] = useState(null);
  // Penalización tras quitar del cupo (pedido de Edu, 2 ago 2026):
  // { userId, libraryId, username, title, monthlyAvailable } o null.
  const [penaltyTarget, setPenaltyTarget] = useState(null);
  // Base para enlazar pósters con Tautulli: la URL pública si está configurada
  // (la interna suele ser un hostname docker que el navegador no resuelve).
  const [statsBase, setStatsBase] = useState('');

  function load() {
    api.quota().then(setUsers);
    api.stats().then(setStats);
    api.pendingApprovals().then(setPendingApprovals).catch(() => {});
    // Módulo Maintainerr opcional: si no está configurado, la lista queda vacía.
    api.salvados().then(setSalvados).catch(() => {});
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
        holdUntil: pa.holdUntil,
        sequentialQueue: Boolean(pa.sequentialQueue),
        previousSeasonNumber: pa.previousSeasonNumber ?? null,
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

  // Salvadas por tarjeta (user_id de Tautulli). Las de gente sin vincular en
  // "Mis avisos" (user_id NULL) no tienen tarjeta y no se pintan aquí.
  const salvadosByUser = useMemo(() => {
    const map = new Map();
    for (const s of salvados) {
      if (s.user_id == null) continue;
      if (!map.has(s.user_id)) map.set(s.user_id, []);
      map.get(s.user_id).push(s);
    }
    return map;
  }, [salvados]);

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
      .sort((a, b) => {
        if (sortBy === 'name') return a.username.localeCompare(b.username, 'es');
        const diff = worstLib(a.libraries).balance - worstLib(b.libraries).balance;
        return sortBy === 'quietest' ? -diff : diff;
      });
  }, [mergedUsers, query, activeFilter, sortBy]);

  // Deudores para las burbujas: los 4 con más pendientes de ver, de más a
  // menos deuda (a igualdad, peor proporción sin ver / pedido primero).
  // ratio ∈ (0,1] dimensiona el anillo (requested puede quedarse corto si el
  // historial no está importado — se acota con el propio owed para no pasar de 1).
  // Nombre de biblioteca por id, para el historial de cupo mensual total
  // (issue #20) — ahí no hay un `lib` concreto de dónde sacarlo.
  const libraryNameById = useMemo(() => {
    return new Map(mergedUsers.flatMap((u) => u.libraries.map((l) => [l.libraryId, l.libraryName])));
  }, [mergedUsers]);

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
    // Con las aprobaciones viejas de Seerr ya en el Registro, reconstruye
    // además qué se vio antes de que el scheduler lo logueara solo (21 jul
    // 2026) — misma fecha real de Tautulli, no "ahora".
    const { backfilled } = await api.backfillWatchedHistory();
    await api.recalculateQuota();
    load();
    setImportResult(`${imported} solicitud(es) importada(s), ${backfilled} vista(s) reconstruida(s)`);
    setImporting(false);
  }

  async function reset(userId, libraryId, username) {
    if (!confirm('¿Resetear el cupo? Todo lo pendiente hasta ahora deja de contar (queda en el Registro, se puede deshacer).')) return;
    const key = `${userId}-${libraryId}`;
    setResetting((r) => ({ ...r, [key]: true }));
    await api.resetQuota(userId, libraryId, username);
    load();
    setResetting((r) => ({ ...r, [key]: false }));
  }

  function manualCharge(userId, libraryId, username, sectionType) {
    setChargeModal({ userId, libraryId, username, sectionType });
  }

  async function submitManualCharge(title, note, posterUrl) {
    const { userId, libraryId } = chargeModal;
    const key = `${userId}-${libraryId}`;
    setCharging((c) => ({ ...c, [key]: true }));
    await api.manualCharge(userId, libraryId, title, chargeModal.username, note, posterUrl);
    setChargeModal(null);
    load();
    setCharging((c) => ({ ...c, [key]: false }));
  }

  async function dismiss(userId, libraryId, item, username) {
    if (!confirm(`¿Quitar "${item.title ?? 'este pendiente'}" del cupo? Queda en el Registro, se puede deshacer.`)) return false;
    await api.dismissPending(userId, libraryId, {
      tmdbId: item.tmdbId,
      seasonNumber: item.seasonNumber ?? null,
      title: item.title,
      username,
    });
    load();
    // Pedido de Edu (2 ago 2026): al quitar algo por no verlo, ofrecer
    // penalizar — la ficha completa (huecos/meses/tipo) se pide en el modal,
    // "No penalizar" ahí mismo es la respuesta negativa.
    const u = users.find((x) => x.userId === userId);
    const lib = u?.libraries.find((l) => l.libraryId === Number(libraryId));
    setPenaltyTarget({
      userId,
      libraryId,
      username,
      title: item.title,
      monthlyAvailable: Boolean(lib?.monthly?.enabled || u?.monthlyTotal?.enabled),
    });
    return true;
  }

  async function submitPenalty({ kind, holes, months }) {
    if (!penaltyTarget) return;
    await api.penalize(penaltyTarget.userId, penaltyTarget.libraryId, {
      kind,
      holes,
      months,
      username: penaltyTarget.username,
    });
    setPenaltyTarget(null);
    load();
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
          <div className="mb-4 text-xs text-gray-500">
            {STAT_TILES[activeFilter].description}
            {activeFilter !== 'all' && (
              <button onClick={() => setActiveFilter('all')} className="ml-2 text-gray-400 hover:text-gray-200 underline">
                quitar filtro
              </button>
            )}
          </div>
        </>
      )}

      <PendingMoviesByAge
        users={mergedUsers}
        onDetail={(user, lib, item) => setDetailTarget({ user, lib, item })}
      />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative max-w-xs">
          <IconSearch className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar usuario…"
            className="input pl-8"
          />
        </div>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="input w-auto py-1.5">
          <option value="busiest">Más ocupados primero</option>
          <option value="quietest">Menos ocupados primero</option>
          <option value="name">Nombre (A-Z)</option>
        </select>
      </div>

      <div className="flex flex-col gap-3">
        {visibleUsers.map((u) => (
          <UserCard
            key={u.userId}
            user={u}
            salvados={salvadosByUser.get(u.userId) ?? []}
            expanded={expanded.has(u.userId)}
            onToggle={() => toggle(u.userId)}
            onReset={reset}
            onDismiss={dismiss}
            onManualCharge={manualCharge}
            onDetail={(user, lib, item) => setDetailTarget({ user, lib, item })}
            onMonthlyHistory={(user, lib) => setMonthlyHistoryTarget({ user, lib })}
            resetting={resetting}
            charging={charging}
          />
        ))}
      </div>

      {monthlyHistoryTarget && (
        <MonthlyHistoryModal
          user={monthlyHistoryTarget.user}
          lib={monthlyHistoryTarget.lib}
          libraryNameById={libraryNameById}
          onClose={() => setMonthlyHistoryTarget(null)}
        />
      )}

      {detailTarget && (
        <PendingDetailModal
          {...detailTarget}
          statsBase={statsBase}
          onClose={() => setDetailTarget(null)}
          onDismiss={async (item) => {
            const done = await dismiss(detailTarget.user.userId, detailTarget.lib.libraryId, item, detailTarget.user.username);
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
          onHold={async (item) => {
            const days = prompt(`¿Aplazar "${item.title ?? 'esta solicitud'}" cuántos días?`, '7');
            if (!days) return;
            const n = Number(days);
            if (!Number.isFinite(n) || n <= 0) return;
            await api.holdRequest(item.requestId, n, {
              userId: detailTarget.user.userId,
              libraryId: detailTarget.lib.libraryId,
              username: detailTarget.user.username,
              title: item.title,
              posterUrl: item.posterUrl,
            });
            load();
            setDetailTarget(null);
          }}
          onClearHold={async (item) => {
            await api.clearRequestHold(item.requestId, {
              userId: detailTarget.user.userId,
              libraryId: detailTarget.lib.libraryId,
              username: detailTarget.user.username,
              title: item.title,
              posterUrl: item.posterUrl,
            });
            load();
            setDetailTarget(null);
          }}
        />
      )}

      {chargeModal && (
        <ManualChargeModal
          username={chargeModal.username}
          sectionType={chargeModal.sectionType}
          onClose={() => setChargeModal(null)}
          onSubmit={submitManualCharge}
        />
      )}

      {penaltyTarget && (
        <PenaltyModal
          username={penaltyTarget.username}
          title={penaltyTarget.title}
          monthlyAvailable={penaltyTarget.monthlyAvailable}
          onClose={() => setPenaltyTarget(null)}
          onSubmit={submitPenalty}
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
