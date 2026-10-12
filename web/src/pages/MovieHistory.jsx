import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ContentByAge } from './Quota.jsx';

export default function MovieHistory({ onNavigate }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.movieHistory()
      .then(setItems)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="page-title">Antigüedad</h2>
        </div>
        <button type="button" onClick={() => onNavigate?.('log')} className="btn btn-ghost">← Volver al Registro</button>
      </div>

      {loading ? (
        <div className="card p-6 text-sm text-gray-500">Cargando historial…</div>
      ) : error ? (
        <div className="card p-6 text-sm text-accent-300">No se ha podido comprobar ahora qué contenidos siguen en Plex.</div>
      ) : (
        <ContentByAge items={items} pageSize={25} />
      )}
    </div>
  );
}
