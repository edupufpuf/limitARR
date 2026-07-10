import { useEffect, useState } from 'react';
import { api } from '../api.js';

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

export default function DecisionsLog() {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    api.decisions().then(setRows);
  }, []);

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Registro de decisiones</h2>
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
                <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{r.created_at}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{r.username}</td>
                <td className="py-2 pr-4">{r.media_title ?? '—'}</td>
                <td className="py-2 pr-4">{r.balance_before ?? '—'}</td>
                <td className="py-2 pr-4">{r.limit_applied ?? '—'}</td>
                <td className={`py-2 pr-4 font-semibold whitespace-nowrap ${decisionColor[r.decision] ?? ''}`}>
                  {decisionLabel[r.decision] ?? r.decision}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-gray-500">
                  Sin decisiones registradas todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
