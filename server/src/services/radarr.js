import { getSettings } from '../settings.js';

// Integración de solo lectura, y solo para UNA cosa: cuando Seerr no tiene
// nada en cola (ver queueStatus en seerr.js), Radarr sigue sabiendo por qué —
// su propio "Estado" (No disponible/Falta/No monitorizada). Deliberadamente NO
// se reintroduce Radarr en el cálculo del cupo (se sacó el 12 jul 2026 para
// desacoplarlo, ver commit d352269) — esto es aparte, solo para la etiqueta.
// Opcional: sin radarr_url/radarr_api_key configurados, getRadarrStatus
// devuelve null sin más y la etiqueta cae al genérico de siempre.
async function call(path) {
  const { radarr_url: baseUrl, radarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) return null;
  try {
    const res = await fetch(`${baseUrl}/api/v3${path}`, { headers: { 'X-Api-Key': apiKey } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function write(path, method, body) {
  const { radarr_url: baseUrl, radarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Radarr no configurado');
  const res = await fetch(`${baseUrl}/api/v3${path}`, {
    method,
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Radarr ${method} ${path} HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function movieByTmdbId(tmdbId) {
  const movies = await call(`/movie?tmdbId=${tmdbId}`);
  return Array.isArray(movies) ? movies[0] ?? null : null;
}

// Control de la lista de espera. PUT exige el recurso completo, no un parche.
export async function setRadarrMovieMonitored(tmdbId, monitored) {
  const movie = await movieByTmdbId(tmdbId);
  if (!movie) return null;
  if (Boolean(movie.monitored) !== Boolean(monitored)) {
    movie.monitored = Boolean(monitored);
    await write(`/movie/${movie.id}`, 'PUT', movie);
  }
  return movie.id;
}

export async function getRadarrWaitState(tmdbId) {
  const movie = await movieByTmdbId(tmdbId);
  if (!movie) return { externalServiceId: null, downloaded: false, downloading: false, releaseAvailable: false };
  const queue = await call('/queue?page=1&pageSize=100');
  const downloading = (queue?.records || []).some((row) => Number(row.movieId) === Number(movie.id));
  let releaseAvailable = false;
  if (!movie.hasFile && !downloading) {
    const releases = await call(`/release?movieId=${movie.id}`);
    releaseAvailable = Array.isArray(releases) && releases.some((release) => (release.rejections || []).length === 0);
  }
  return { externalServiceId: movie.id, downloaded: Boolean(movie.hasFile), downloading, releaseAvailable };
}

export async function searchRadarrMovie(tmdbId) {
  const movieId = await setRadarrMovieMonitored(tmdbId, true);
  if (movieId == null) throw new Error(`pelicula TMDB ${tmdbId} no encontrada en Radarr`);
  await write('/command', 'POST', { name: 'MoviesSearch', movieIds: [movieId] });
  return movieId;
}

// El campo "Estado" que muestra la propia ficha de Radarr NO es el status de
// estreno (tba/announced/inCinemas/released) — es esta lógica aparte, según
// isAvailable/monitored/hasFile (verificado contra la app de Radarr en
// producción: Toy Story 5 con isAvailable=false enseña "No Disponible", no
// nada relacionado con estar en cines).
export async function getRadarrStatus(radarrId) {
  if (radarrId == null) return null;
  const movie = await call(`/movie/${radarrId}`);
  if (!movie || movie.hasFile) return null; // con archivo ya es "disponible" vía Seerr
  if (!movie.monitored) return 'No monitorizada';
  if (!movie.isAvailable) return 'No disponible';
  return 'Falta'; // ya cumple minimumAvailability pero aún sin archivo
}

// Issue #22 (jesusgarrigues): botón "Ver en Radarr" en la ventana de detalle.
// Busca por tmdbId (no hace falta el id interno de Radarr, que limitARR no
// guarda en ningún sitio) y arma la URL con titleSlug — Radarr acepta el slug
// tal cual en su UI (a veces es el propio tmdbId como texto si el título no
// generó uno "bonito", verificado contra producción); con id numérico también
// funciona, pero el slug es lo que la propia API expone para esto.
export async function getRadarrMovieUrl(tmdbId) {
  const { radarr_url: baseUrl } = getSettings();
  if (!baseUrl || tmdbId == null) return null;
  const movies = await call(`/movie?tmdbId=${tmdbId}`);
  const movie = Array.isArray(movies) ? movies[0] : null;
  if (!movie) return null;
  return `${baseUrl}/movie/${movie.titleSlug ?? movie.id}`;
}

export async function testRadarrServer() {
  const { radarr_url: baseUrl, radarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Radarr no configurado (pestaña Configuración)');
  const res = await fetch(`${baseUrl}/api/v3/system/status`, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) throw new Error(`Radarr HTTP ${res.status}`);
}
