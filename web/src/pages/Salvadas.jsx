import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { IconSearch, IconUsers, IconSave } from '../icons.jsx';
import { SalvadosGrid, salvadoDaysLeft } from '../components/Salvados.jsx';

const REFRESH_MS = 60_000;

function soonestDaysLeft(items) {
  return items.reduce((min, item) => Math.min(min, salvadoDaysLeft(item)), Infinity);
}

function GroupCard({ group, expanded, onToggle }) {
  const soonest = soonestDaysLeft(group.items);
  return (
    <div className="card overflow-hidden hover:border-bg-600/80 transition-colors">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-bg-700/40 transition-colors"
      >
        <span className="w-12 h-12 rounded-full overflow-hidden bg-bg-700 flex items-center justify-center flex-shrink-0">
          {group.isGroup ? (
            <IconUsers className="w-5 h-5 text-gray-300" />
          ) : group.avatar ? (
            <img src={group.avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="text-xs font-bold">{group.label.slice(0, 2).toUpperCase()}</span>
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">
            {group.label}
            {!group.linked && (
              <span className="ml-1.5 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-700 text-gray-400 ring-1 ring-bg-600 align-middle">
                sin vincular
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {group.items.length} salvada{group.items.length === 1 ? '' : 's'}
            {Number.isFinite(soonest) && ` · la más próxima caduca en ${soonest} día${soonest === 1 ? '' : 's'}`}
          </div>
        </div>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-700 p-4 bg-bg-900/30">
          <SalvadosGrid items={group.items} />
        </div>
      )}
    </div>
  );
}

export default function Salvadas() {
  const [salvados, setSalvados] = useState([]);
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(new Set());

  function load() {
    api.salvados().then(setSalvados).catch(() => {});
  }

  useEffect(() => {
    load();
    api.users().then(setUsers).catch(() => {});
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // Agrupa por user_id (Tautulli, resuelto vía telegram_links al salvar); sin
  // vincular cae a un cubo por nombre de Telegram — no hay tarjeta de cupo
  // donde colgarlo, pero sigue siendo útil verlo.
  const groups = useMemo(() => {
    const byUserId = new Map(users.map((u) => [u.userId, u]));
    const map = new Map();
    for (const s of salvados) {
      const key = s.user_id != null ? `u:${s.user_id}` : `tg:${s.telegram_name ?? 'desconocido'}`;
      if (!map.has(key)) {
        const user = s.user_id != null ? byUserId.get(s.user_id) : null;
        map.set(key, {
          key,
          label: user?.username ?? s.telegram_name ?? 'Sin vincular',
          avatar: user?.avatar ?? null,
          isGroup: user?.isGroup ?? false,
          linked: s.user_id != null,
          items: [],
        });
      }
      map.get(key).items.push(s);
    }
    return [...map.values()].sort((a, b) => soonestDaysLeft(a.items) - soonestDaysLeft(b.items));
  }, [salvados, users]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((g) => !q || g.label.toLowerCase().includes(q));
  }, [groups, query]);

  function toggle(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="page-title">Salvadas por usuario</h2>
          <p className="text-sm text-gray-500 mt-1">
            Películas rescatadas del borrado de Maintainerr con 💾 Salvar en Telegram. Se refresca solo cada minuto.
          </p>
        </div>
      </div>

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
        {visibleGroups.map((g) => (
          <GroupCard key={g.key} group={g} expanded={expanded.has(g.key)} onToggle={() => toggle(g.key)} />
        ))}
      </div>

      {salvados.length === 0 && (
        <p className="text-gray-500 text-sm py-6 text-center">
          Nadie ha salvado ninguna película todavía.
        </p>
      )}
      {salvados.length > 0 && visibleGroups.length === 0 && (
        <p className="text-gray-500 text-sm py-6 text-center">Ningún usuario coincide con "{query}".</p>
      )}
    </div>
  );
}
