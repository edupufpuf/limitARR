import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { IconSearch } from '../icons.jsx';

const PAGE_SIZE = 50;

const actionBadge = {
  deleted: 'bg-accent-500/10 text-accent-400 ring-accent-500/25',
  tagged: 'bg-yellow-400/10 text-yellow-400 ring-yellow-400/25',
  error: 'bg-bg-700/60 text-gray-400 ring-bg-600',
};

const actionLabel = {
  deleted: 'borrada',
  tagged: 'etiquetada',
  error: 'error',
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

export default function EliminarrHistory() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [actionTaken, setActionTaken] = useState('');
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  function buildParams(offset) {
    const params = { limit: PAGE_SIZE, offset };
    if (actionTaken) params.action_taken = actionTaken;
    if (q.trim()) params.q = q.trim();
    return params;
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      api.eliminarrHistory(buildParams(0)).then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      });
    }, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [actionTaken, q]);

  async function loadMore() {
    setLoadingMore(true);
    const r = await api.eliminarrHistory(buildParams(rows.length));
    setRows((prev) => [...prev, ...r.rows]);
    setTotal(r.total);
    setLoadingMore(false);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <span className="text-xs text-gray-500">{total} en total</span>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative">
          <IconSearch className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Título o regla…"
            className="input w-48 pl-8"
          />
        </div>
        <select value={actionTaken} onChange={(e) => setActionTaken(e.target.value)} className="input w-auto">
          <option value="">todas las acciones</option>
          {Object.entries(actionLabel).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="card overflow-x-auto px-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-bg-700">
              <th className="th">Fecha</th>
              <th className="th">Regla</th>
              <th className="th">Título</th>
              <th className="th">Acción</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-bg-700/50 last:border-0 hover:bg-bg-700/20 transition-colors">
                <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{formatDate(r.created_at)}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{r.rule_name}</td>
                <td className="py-2 pr-4">
                  <span className="flex items-center gap-2">
                    {r.poster_url && (
                      <img src={r.poster_url} alt="" loading="lazy" className="w-6 h-9 object-cover rounded flex-shrink-0" />
                    )}
                    {r.title ?? '—'}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  <span
                    className={`badge ${actionBadge[r.action_taken] ?? 'bg-bg-700/60 text-gray-400 ring-bg-600'}`}
                    title={r.error || undefined}
                  >
                    {actionLabel[r.action_taken] ?? r.action_taken}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-gray-500">
                  {actionTaken || q ? 'Nada coincide con los filtros.' : 'Sin ejecuciones registradas todavía.'}
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
