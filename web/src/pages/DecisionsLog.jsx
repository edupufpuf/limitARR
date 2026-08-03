import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { IconSearch } from '../icons.jsx';

const PAGE_SIZE = 50;

const decisionBadge = {
  approved: 'bg-green-400/10 text-green-400 ring-green-400/25',
  no_quota: 'bg-accent-500/10 text-accent-400 ring-accent-500/25',
  no_monthly_quota: 'bg-accent-500/10 text-accent-400 ring-accent-500/25',
  no_monthly_total_quota: 'bg-accent-500/10 text-accent-400 ring-accent-500/25',
  declined: 'bg-accent-500/10 text-accent-400 ring-accent-500/25',
  declined_multi_season: 'bg-accent-500/10 text-accent-400 ring-accent-500/25',
  season_hold: 'bg-yellow-400/10 text-yellow-400 ring-yellow-400/25',
  held: 'bg-yellow-400/10 text-yellow-400 ring-yellow-400/25',
  no_library_config: 'bg-bg-700/60 text-gray-400 ring-bg-600',
  unmatched_user: 'bg-bg-700/60 text-gray-400 ring-bg-600',
  salvado: 'bg-sky-400/10 text-sky-400 ring-sky-400/25',
  dismissed: 'bg-orange-400/10 text-orange-400 ring-orange-400/25',
  reset: 'bg-orange-400/10 text-orange-400 ring-orange-400/25',
  hold_cleared: 'bg-yellow-400/10 text-yellow-400 ring-yellow-400/25',
  override_changed: 'bg-violet-400/10 text-violet-400 ring-violet-400/25',
  group_override_changed: 'bg-violet-400/10 text-violet-400 ring-violet-400/25',
  role_override_changed: 'bg-violet-400/10 text-violet-400 ring-violet-400/25',
  monthly_total_override_changed: 'bg-violet-400/10 text-violet-400 ring-violet-400/25',
  group_monthly_total_override_changed: 'bg-violet-400/10 text-violet-400 ring-violet-400/25',
  role_monthly_total_override_changed: 'bg-violet-400/10 text-violet-400 ring-violet-400/25',
  watched: 'bg-green-400/10 text-green-400 ring-green-400/25',
  expired: 'bg-bg-700/60 text-gray-400 ring-bg-600',
  unavailable_reminder: 'bg-sky-400/10 text-sky-400 ring-sky-400/25',
  penalty_applied: 'bg-orange-400/10 text-orange-400 ring-orange-400/25',
  approved_outside_limitarr: 'bg-violet-400/10 text-violet-400 ring-violet-400/25',
};

const decisionLabel = {
  approved: 'aprobada',
  no_quota: 'sin cupo',
  no_monthly_quota: 'sin cupo mensual',
  no_monthly_total_quota: 'sin cupo mensual total',
  declined: 'rechazada',
  declined_multi_season: 'rechazada (varias temporadas)',
  season_hold: 'en cola (temporada anterior sin ver)',
  held: '⏳ aplazada',
  no_library_config: 'sin biblioteca configurada',
  unmatched_user: 'usuario no encontrado en Tautulli',
  salvado: '💾 salvada',
  dismissed: '✕ quitada del cupo',
  reset: '↺ cupo reseteado',
  hold_cleared: 'aplazamiento cancelado',
  override_changed: 'override cambiado',
  group_override_changed: 'override de grupo cambiado',
  role_override_changed: 'override de rol cambiado',
  monthly_total_override_changed: 'override de cupo mensual total cambiado',
  group_monthly_total_override_changed: 'override de cupo mensual total (grupo) cambiado',
  role_monthly_total_override_changed: 'override de cupo mensual total (rol) cambiado',
  watched: '👁️ visto (cupo liberado)',
  expired: '⌛ caducado (cupo liberado)',
  unavailable_reminder: '🕐 aviso: aún no disponible (12h)',
  penalty_applied: '⛔ penalización aplicada',
  approved_outside_limitarr: '✅ aprobada fuera de limitARR (autoaprobado/admin)',
};

// created_at viene de SQLite en UTC ('YYYY-MM-DD HH:MM:SS'); se enseña en local.
function formatDate(createdAt) {
  const date = new Date(createdAt.replace(' ', 'T') + 'Z');
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DecisionsLog() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [decision, setDecision] = useState('');
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [undoing, setUndoing] = useState({});

  function undoConfirmText(row) {
    switch (row.decision) {
      case 'reset': return '¿Deshacer este reseteo del cupo?';
      case 'dismissed': return `¿Deshacer? "${row.media_title ?? 'esto'}" vuelve a contar para el cupo.`;
      case 'approved': return `¿Deshacer la aprobación de "${row.media_title ?? 'esto'}"? Se rechaza también en Seerr (cancela la descarga si estaba en curso).`;
      case 'declined': return `¿Deshacer el rechazo de "${row.media_title ?? 'esto'}"? Se aprueba también en Seerr.`;
      case 'held': return `¿Quitar el aplazamiento de "${row.media_title ?? 'esta solicitud'}"?`;
      case 'hold_cleared': return `¿Restaurar el aplazamiento de "${row.media_title ?? 'esta solicitud'}"?`;
      default: return '¿Deshacer este cambio de override?';
    }
  }

  async function undo(row) {
    if (!confirm(undoConfirmText(row))) return;
    setUndoing((u) => ({ ...u, [row.id]: true }));
    try {
      await api.undoDecision(row.id);
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, undone_at: new Date().toISOString() } : r)));
    } finally {
      setUndoing((u) => ({ ...u, [row.id]: false }));
    }
  }

  function buildParams(offset) {
    const params = { limit: PAGE_SIZE, offset };
    if (decision) params.decision = decision;
    if (q.trim()) params.q = q.trim();
    return params;
  }

  // Recarga desde cero al cambiar filtros; la búsqueda de texto va con un
  // pequeño debounce para no disparar una petición por tecla.
  useEffect(() => {
    const timer = setTimeout(() => {
      api.decisions(buildParams(0)).then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      });
    }, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [decision, q]);

  async function loadMore() {
    setLoadingMore(true);
    const r = await api.decisions(buildParams(rows.length));
    setRows((prev) => [...prev, ...r.rows]);
    setTotal(r.total);
    setLoadingMore(false);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="page-title">Registro de decisiones</h2>
        <span className="text-xs text-gray-500">{total} en total</span>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative">
          <IconSearch className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Usuario o título…"
            className="input w-48 pl-8"
          />
        </div>
        <select
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          className="input w-auto"
        >
          <option value="">todas las decisiones</option>
          {Object.entries(decisionLabel).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="card overflow-x-auto px-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-bg-700">
              <th className="th">Fecha</th>
              <th className="th">Usuario</th>
              <th className="th">Título</th>
              <th className="th">Saldo antes</th>
              <th className="th">Límite</th>
              <th className="th">Decisión</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              // 'salvado' sale de una tabla distinta (salvados): el id puede
              // coincidir con el de una fila de decisions_log, así que la key
              // va con la decisión delante para no colisionar.
              <tr key={`${r.decision}-${r.id}`} className="border-b border-bg-700/50 last:border-0 hover:bg-bg-700/20 transition-colors">
                <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{formatDate(r.created_at)}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{r.username}</td>
                <td className="py-2 pr-4">
                  <span className="flex items-center gap-2">
                    {r.poster_url && (
                      <img src={r.poster_url} alt="" loading="lazy" className="w-6 h-9 object-cover rounded flex-shrink-0" />
                    )}
                    <span>
                      <span className="block">{r.media_title ?? '—'}</span>
                      {r.note && <span className="block text-xs text-gray-500">📝 {r.note}</span>}
                    </span>
                  </span>
                </td>
                <td className="py-2 pr-4 tabular-nums">{r.balance_before ?? '—'}</td>
                <td className="py-2 pr-4 tabular-nums">{r.limit_applied ?? '—'}</td>
                <td className="py-2 pr-4">
                  <span className={`badge ${decisionBadge[r.decision] ?? 'bg-bg-700/60 text-gray-400 ring-bg-600'}`}>
                    {decisionLabel[r.decision] ?? r.decision}
                  </span>
                </td>
                <td className="py-2 pr-4 whitespace-nowrap">
                  {Boolean(r.undoable) && (
                    r.undone_at ? (
                      <span className="text-xs text-gray-600">deshecho</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => undo(r)}
                        disabled={undoing[r.id]}
                        className="text-xs text-accent-400 hover:text-accent-300 disabled:opacity-50"
                      >
                        {undoing[r.id] ? 'deshaciendo…' : 'deshacer'}
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-gray-500">
                  {decision || q ? 'Nada coincide con los filtros.' : 'Sin decisiones registradas todavía.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length < total && (
        <div className="text-center mt-4">
          <button onClick={loadMore} disabled={loadingMore} className="btn btn-ghost">
            {loadingMore ? 'Cargando…' : `Cargar más (${total - rows.length} restantes)`}
          </button>
        </div>
      )}
    </div>
  );
}
