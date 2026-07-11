import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { IconSearch } from '../icons.jsx';

const REFRESH_MS = 60_000;

function balanceColor(balance) {
  if (balance <= 0) return 'text-accent-400';
  if (balance <= 1) return 'text-yellow-400';
  return 'text-green-400';
}

function barColor(balance) {
  if (balance <= 0) return 'bg-accent-500';
  if (balance <= 1) return 'bg-yellow-400';
  return 'bg-green-400';
}

function worstBalance(libraries) {
  return Math.min(...libraries.map((l) => l.balance));
}

function totalOutstanding(libraries) {
  return libraries.reduce((sum, l) => sum + l.outstanding, 0);
}

// Fila de KPIs de la cabecera. Números en tinta normal; el color queda para
// los saldos de las tarjetas, donde sí es semántico.
function StatTile({ label, value }) {
  return (
    <div className="bg-bg-800 border border-bg-700 rounded-lg px-4 py-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

// Saldo restante sobre el límite, como barra: llena y verde = cupo libre.
function QuotaBar({ balance, limit }) {
  const pct = limit > 0 ? Math.round((balance / limit) * 100) : 0;
  return (
    <div className="h-1.5 rounded-full bg-bg-600 overflow-hidden" title={`${balance} de ${limit}`}>
      <div className={`h-full rounded-full ${barColor(balance)}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function PendingPoster({ item }) {
  return (
    <div className="flex flex-col items-center w-14" title={item.title ?? ''}>
      {item.posterUrl ? (
        <img
          src={item.posterUrl}
          alt=""
          loading="lazy"
          className="w-12 h-[72px] object-cover rounded shadow"
        />
      ) : (
        <div className="w-12 h-[72px] rounded bg-bg-600 flex items-center justify-center text-lg">🎬</div>
      )}
      <span className="text-[10px] text-gray-400 mt-1 w-full truncate text-center">
        {item.title ?? '—'}
      </span>
    </div>
  );
}

function UserCard({ user, expanded, onToggle, onReset, resetting }) {
  const worst = worstBalance(user.libraries);
  const pending = totalOutstanding(user.libraries);
  return (
    <div className="bg-bg-800 border border-bg-700 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-bg-700/50 transition-colors"
      >
        {user.avatar ? (
          <img src={user.avatar} alt="" className="w-10 h-10 rounded-full flex-shrink-0" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-bg-600 flex items-center justify-center text-sm font-bold flex-shrink-0">
            {user.username.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{user.username}</div>
          <div className="text-xs text-gray-500">
            {pending === 0 ? 'sin pendientes' : `${pending} pendiente(s)`} · {user.libraries.length} biblioteca(s)
          </div>
        </div>
        <span className={`text-lg font-bold tabular-nums ${balanceColor(worst)}`}>{worst}</span>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-700 p-4 space-y-4">
          {user.libraries.map((lib) => {
            const key = `${user.userId}-${lib.libraryId}`;
            return (
              <div key={key}>
                <div className="flex items-center gap-3 text-sm mb-1.5">
                  <span className="flex-1 truncate">{lib.libraryName}</span>
                  <span className="text-gray-400 tabular-nums">
                    <span className={`font-bold ${balanceColor(lib.balance)}`}>{lib.balance}</span>
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
      .sort((a, b) => worstBalance(a.libraries) - worstBalance(b.libraries));
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
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-xl font-semibold">Cupo por usuario</h2>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {importResult && <span className="text-xs text-gray-500">{importResult}</span>}
          <button
            onClick={importHistory}
            disabled={importing}
            className="bg-bg-700 hover:bg-bg-600 border border-bg-600 rounded px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {importing ? 'Importando…' : 'Importar historial de Seerr'}
          </button>
          <button
            onClick={recalculate}
            disabled={recalculating}
            className="bg-bg-700 hover:bg-bg-600 border border-bg-600 rounded px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {recalculating ? 'Recalculando…' : 'Recalcular todos'}
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
          <StatTile label="usuarios" value={stats.users} />
          <StatTile label="películas sin ver" value={stats.outstanding} />
          <StatTile label="usuarios sin saldo" value={stats.usersBlocked} />
          <StatTile label="aprobadas (7 días)" value={stats.approved7d} />
          <StatTile label="sin cupo (7 días)" value={stats.blocked7d} />
        </div>
      )}

      <p className="text-xs text-gray-500 mb-4">
        Saldo = límite − películas aprobadas pendientes de ver (nunca baja de 0). Se restaura según
        el usuario ve lo que pidió, o de golpe con "Resetear". El número junto al avatar es el peor
        saldo entre sus bibliotecas. Se actualiza solo cada minuto.
      </p>

      <div className="relative mb-4 max-w-xs">
        <IconSearch className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar usuario…"
          className="w-full bg-bg-800 border border-bg-700 rounded pl-8 pr-2 py-1.5 text-sm placeholder-gray-600"
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
