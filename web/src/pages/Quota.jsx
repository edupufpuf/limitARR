import { useEffect, useMemo, useState } from 'react';
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

function StatTile({ label, value, Icon, tint }) {
  return (
    <div className="card px-4 py-3 flex items-center gap-3 min-w-0">
      <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${tint}`}>
        <Icon className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-bold tabular-nums leading-tight">{value}</div>
        <div className="text-[11px] uppercase tracking-wider text-gray-500 truncate">{label}</div>
      </div>
    </div>
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

// Póster grande con el título en overlay sobre gradiente, estilo Seerr.
function PendingPoster({ item }) {
  return (
    <div className="relative w-16 h-24 rounded-lg overflow-hidden shadow-card group flex-shrink-0" title={item.title ?? ''}>
      {item.posterUrl ? (
        <img
          src={item.posterUrl}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
        />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-bg-600 to-bg-700 flex items-center justify-center text-xl">🎬</div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-6 pb-1 px-1.5 pointer-events-none">
        <span className="block text-[9px] leading-tight text-gray-100 font-medium line-clamp-2">
          {item.title ?? '—'}
        </span>
      </div>
    </div>
  );
}

// Pila de mini-carátulas solapadas para la cabecera plegada de la tarjeta.
function PosterStack({ libraries }) {
  const items = libraries.flatMap((l) => l.pendingItems ?? []).slice(0, 3);
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

function UserCard({ user, expanded, onToggle, onReset, resetting }) {
  const worst = worstLib(user.libraries);
  const pending = totalOutstanding(user.libraries);
  return (
    <div className="card overflow-hidden hover:border-bg-600/80 transition-colors">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-bg-700/40 transition-colors"
      >
        <BalanceRing balance={worst.balance} limit={worst.limitApplied}>
          {user.avatar ? (
            <img src={user.avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="text-xs font-bold">{user.username.slice(0, 2).toUpperCase()}</span>
          )}
        </BalanceRing>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{user.username}</div>
          <div className="text-xs text-gray-500">
            {pending === 0 ? 'sin pendientes' : `${pending} pendiente(s)`} · {user.libraries.length} biblioteca(s)
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
                      <PendingPoster key={item.tmdbId ?? `${key}-${i}`} item={item} />
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
  const [query, setQuery] = useState('');
  const [recalculating, setRecalculating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [resetting, setResetting] = useState({});
  const [expanded, setExpanded] = useState(new Set());

  function load() {
    api.quota().then(setUsers);
    api.stats().then(setStats);
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => !q || u.username.toLowerCase().includes(q))
      .sort((a, b) => worstLib(a.libraries).balance - worstLib(b.libraries).balance);
  }, [users, query]);

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
          <h2 className="text-2xl font-bold tracking-tight">Cupo por usuario</h2>
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

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          <StatTile label="usuarios" value={stats.users} Icon={IconUsers} tint="bg-bg-700/70 text-gray-300" />
          <StatTile label="sin ver" value={stats.outstanding} Icon={IconEye} tint="bg-blue-400/10 text-blue-400" />
          <StatTile label="sin saldo" value={stats.usersBlocked} Icon={IconBan} tint="bg-accent-500/10 text-accent-400" />
          <StatTile label="aprobadas · 7d" value={stats.approved7d} Icon={IconCheckCircle} tint="bg-green-400/10 text-green-400" />
          <StatTile label="sin cupo · 7d" value={stats.blocked7d} Icon={IconXCircle} tint="bg-yellow-400/10 text-yellow-400" />
        </div>
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
            resetting={resetting}
          />
        ))}
      </div>

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
