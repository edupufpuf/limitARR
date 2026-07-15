// Módulo Maintainerr: rejilla de películas "salvadas" del borrado con el botón
// 💾 de Telegram, con cuenta atrás hasta que Maintainerr las borre de verdad.

export function salvadoDaysLeft(item) {
  // expires_at viene de SQLite en UTC sin zona ("YYYY-MM-DD HH:MM:SS").
  const ms = new Date(`${item.expires_at.replace(' ', 'T')}Z`) - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
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
