import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { IconSearch } from '../icons.jsx';

const PAGE_SIZE = 50;

const decisionColor = {
  approved: 'text-green-400',
  no_quota: 'text-accent-400',
  no_library_config: 'text-gray-500',
  unmatched_user: 'text-gray-500',
};

const decisionLabel = {
  approved: 'aprobada',
  no_quota: 'sin cupo',
  no_library_config: 'sin biblioteca configurada',
  unmatched_user: 'usuario no encontrado en Tautulli',
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
        <h2 className="text-xl font-semibold">Registro de decisiones</h2>
        <span className="text-xs text-gray-500">{total} en total</span>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative">
          <IconSearch className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Usuario o título…"
            className="w-48 bg-bg-800 border border-bg-700 rounded pl-8 pr-2 py-1.5 text-sm placeholder-gray-600"
          />
        </div>
        <select
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          className="bg-bg-800 border border-bg-700 rounded px-2 py-1.5 text-sm"
        >
          <option value="">todas las decisiones</option>
          {Object.entries(decisionLabel).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-bg-700">
              <th className="py-2 pr-4">Fecha</th>
              <th className="py-2 pr-4">Usuario</th>
              <th className="py-2 pr-4">Título</th>
              <th className="py-2 pr-4">Saldo antes</th>
              <th className="py-2 pr-4">Límite</th>
              <th className="py-2 pr-4">Decisión</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-bg-800">
                <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{formatDate(r.created_at)}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{r.username}</td>
                <td className="py-2 pr-4">
                  <span className="flex items-center gap-2">
                    {r.poster_url && (
                      <img src={r.poster_url} alt="" loading="lazy" className="w-6 h-9 object-cover rounded flex-shrink-0" />
                    )}
                    {r.media_title ?? '—'}
                  </span>
                </td>
                <td className="py-2 pr-4 tabular-nums">{r.balance_before ?? '—'}</td>
                <td className="py-2 pr-4 tabular-nums">{r.limit_applied ?? '—'}</td>
                <td className={`py-2 pr-4 font-semibold whitespace-nowrap ${decisionColor[r.decision] ?? ''}`}>
                  {decisionLabel[r.decision] ?? r.decision}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-gray-500">
                  {decision || q ? 'Nada coincide con los filtros.' : 'Sin decisiones registradas todavía.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length < total && (
        <div className="text-center mt-4">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="bg-bg-700 hover:bg-bg-600 border border-bg-600 rounded px-4 py-1.5 text-sm disabled:opacity-50"
          >
            {loadingMore ? 'Cargando…' : `Cargar más (${total - rows.length} restantes)`}
          </button>
        </div>
      )}
    </div>
  );
}
