import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Solicitudes aprobadas que salieron del cupo porque se borraron/cancelaron
// (aprobación anulada) antes de que el usuario las viera — decision
// 'deleted_unwatched', ver classifyGoneItem en scheduler.js.
function formatDate(createdAt) {
  const date = new Date(String(createdAt).replace(' ', 'T') + 'Z');
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid',
  }).format(date);
}

export default function DeletedUnwatched({ onNavigate }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [user, setUser] = useState('');

  useEffect(() => {
    api.decisions({ decision: 'deleted_unwatched', limit: 200, offset: 0 })
      .then((r) => setRows(r.rows))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  const byUser = useMemo(() => {
    const counts = new Map();
    for (const r of rows) {
      const name = r.username ?? 'desconocido';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
  }, [rows]);

  const visible = user ? rows.filter((r) => (r.username ?? 'desconocido') === user) : rows;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <h2 className="page-title">Borradas sin ver</h2>
        <button type="button" onClick={() => onNavigate?.('log')} className="btn btn-ghost">← Volver al Registro</button>
      </div>

      {loading ? (
        <div className="card p-6 text-sm text-gray-500">Cargando…</div>
      ) : error ? (
        <div className="card p-6 text-sm text-accent-300">No se ha podido cargar el listado.</div>
      ) : rows.length === 0 ? (
        <div className="card p-6 text-sm text-gray-500">No hay nada borrado sin ver.</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-4">
            <button type="button" onClick={() => setUser('')} className={`chip ${!user ? '!bg-ink !text-on-ink' : ''}`}>
              Todos <span className="tabular-nums opacity-70">{rows.length}</span>
            </button>
            {byUser.map(([name, count]) => (
              <button key={name} type="button" onClick={() => setUser(name)} className={`chip ${user === name ? '!bg-ink !text-on-ink' : ''}`}>
                {name} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            ))}
          </div>

          <div className="card divide-y divide-bg-700/70">
            {visible.map((r) => (
              <article key={r.id} className="p-4 flex gap-3 items-center">
                <div className="w-12 h-[72px] rounded-xl bg-bg-700 overflow-hidden flex-shrink-0">
                  {r.poster_url
                    ? <img src={r.poster_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    : <span className="w-full h-full flex items-center justify-center">🎬</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold leading-snug">{r.media_title ?? 'Sin título'}</div>
                  <div className="mt-1 text-xs text-gray-400">{r.username ?? 'desconocido'}</div>
                </div>
                <div className="text-xs text-gray-500 tabular-nums whitespace-nowrap">{formatDate(r.created_at)}</div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
