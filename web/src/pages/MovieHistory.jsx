import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { MoviesByAge } from './Quota.jsx';

export default function MovieHistory({ onNavigate }) {
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.movieHistory()
      .then(setMovies)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="page-title">Antigüedad de películas</h2>
          <p className="text-sm text-gray-500 mt-1">Todas las películas solicitadas, incluidas las vistas, retiradas y todavía pendientes.</p>
        </div>
        <button type="button" onClick={() => onNavigate?.('quota')} className="btn btn-ghost">← Volver a Cupo</button>
      </div>

      {loading ? (
        <div className="card p-6 text-sm text-gray-500">Cargando historial…</div>
      ) : error ? (
        <div className="card p-6 text-sm text-accent-300">No se ha podido comprobar ahora qué películas siguen en Plex.</div>
      ) : (
        <MoviesByAge movies={movies} initialVisible={2} />
      )}
    </div>
  );
}
