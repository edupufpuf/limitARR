import { useEffect, useState } from 'react';
import { api } from '../api.js';

function balanceColor(balance) {
  if (balance <= 0) return 'text-accent-400';
  if (balance <= 1) return 'text-yellow-400';
  return 'text-green-400';
}

function worstBalance(libraries) {
  return Math.min(...libraries.map((l) => l.balance));
}

function UserCard({ user, expanded, onToggle, onReset, resetting }) {
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
          <div className="text-xs text-gray-500">{user.libraries.length} biblioteca(s)</div>
        </div>
        <span className={`text-lg font-bold ${balanceColor(worstBalance(user.libraries))}`}>
          {worstBalance(user.libraries)}
        </span>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-700 p-4 space-y-3">
          {user.libraries.map((lib) => {
            const key = `${user.userId}-${lib.libraryId}`;
            return (
              <div key={key} className="flex items-center gap-3 text-sm">
                <span className="flex-1 truncate">{lib.libraryName}</span>
                <span className={`font-bold w-6 text-right ${balanceColor(lib.balance)}`}>{lib.balance}</span>
                <span className="text-gray-500">/ {lib.limitApplied}</span>
                <span className="text-gray-500 w-32 text-right">{lib.outstanding} pendiente(s)</span>
                <button
                  onClick={() => onReset(user.userId, lib.libraryId)}
                  disabled={resetting[key]}
                  className="text-accent-400 text-xs disabled:opacity-50"
                >
                  {resetting[key] ? 'reseteando…' : 'resetear'}
                </button>
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
  const [recalculating, setRecalculating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [resetting, setResetting] = useState({});
  const [expanded, setExpanded] = useState(new Set());

  function load() {
    api.quota().then(setUsers);
  }

  useEffect(load, []);

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
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Cupo por usuario</h2>
        <div className="flex items-center gap-3">
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
      <p className="text-xs text-gray-500 mb-4">
        Saldo = límite − películas aprobadas pendientes de ver (nunca baja de 0). Se restaura según
        el usuario ve lo que pidió, o de golpe con "Resetear". El número junto al avatar es el peor
        saldo entre sus bibliotecas.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {users.map((u) => (
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
    </div>
  );
}
