// Módulo Maintainerr: rejilla de películas "salvadas" del borrado con el botón
// 💾 de Telegram, con cuenta atrás hasta que Maintainerr las borre de verdad.

export function salvadoDaysLeft(item) {
  // expires_at viene de SQLite en UTC sin zona ("YYYY-MM-DD HH:MM:SS").
  const ms = new Date(`${item.expires_at.replace(' ', 'T')}Z`) - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function sqliteToMs(text) {
  return new Date(`${text.replace(' ', 'T')}Z`).getTime();
}

// Historial de salvadas (activas o ya resueltas) agrupado por película: una
// fila de salvados es UN salvador, así que una misma película con 2+
// salvadores sale como un solo grupo con su estado de "vista" por cabeza.
export function groupSalvadosByMedia(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.media_server_id)) {
      map.set(r.media_server_id, { mediaServerId: r.media_server_id, title: r.title, posterUrl: r.poster_url, savers: [] });
    }
    map.get(r.media_server_id).savers.push(r);
  }
  return [...map.values()].sort(
    (a, b) => Math.max(...b.savers.map((s) => sqliteToMs(s.saved_at))) - Math.max(...a.savers.map((s) => sqliteToMs(s.saved_at)))
  );
}

function saverStatus(row) {
  if (row.watched_at) return { icon: '✅', label: 'vista' };
  if (row.resolved_at) return { icon: '❌', label: 'no vista (borrada)' };
  return { icon: '⏳', label: 'pendiente de ver' };
}

// Pedido de Edu (8 ago 2026): últimas salvadas de los últimos 30 días,
// resueltas o no, con si cada salvador la ha visto.
export function SalvadosHistoryList({ items }) {
  const groups = groupSalvadosByMedia(items);
  if (groups.length === 0) {
    return <p className="text-gray-500 text-sm py-4 text-center">Nada salvado en los últimos 30 días.</p>;
  }
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={g.mediaServerId} className="card p-3 flex gap-3">
          <div className="w-12 aspect-[2/3] rounded overflow-hidden bg-bg-950 flex-shrink-0" title={g.title ?? 'Sin título'}>
            {g.posterUrl ? (
              <img src={g.posterUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full bg-gradient-to-br from-bg-600 to-bg-800" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{g.title ?? 'Sin título'}</p>
            <div className="flex flex-col gap-0.5 mt-1">
              {g.savers.map((s) => {
                const status = saverStatus(s);
                return (
                  <span key={s.id} className="text-xs text-gray-400">
                    {status.icon} {s.telegram_name ?? 'alguien'} — {status.label}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SalvadosGrid({ items, compact = false }) {
  return (
    <div className={compact ? 'flex flex-wrap gap-2' : 'grid grid-cols-3 sm:grid-cols-5 gap-3'}>
      {items.map((item) => (
        <div key={item.id} className={compact ? 'w-16' : undefined}>
          <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-bg-950" title={item.title ?? 'Película salvada'}>
            {item.poster_url ? (
              <img src={item.poster_url} alt="" loading="lazy" className="h-full w-full object-cover" />
            ) : <div className="h-full w-full bg-gradient-to-br from-bg-600 to-bg-800" />}
            <span className="absolute left-1 top-1 rounded bg-black/80 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-green-300">
              {salvadoDaysLeft(item)} días
            </span>
          </div>
          <p className="text-[11px] text-gray-400 mt-1 line-clamp-2">{item.title ?? 'Sin título'}</p>
        </div>
      ))}
    </div>
  );
}
