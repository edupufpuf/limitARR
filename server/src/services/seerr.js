import { getSettings } from '../settings.js';
import { getRadarrStatus } from './radarr.js';
import { getSonarrSeasonStatus } from './sonarr.js';

async function call(path, options = {}) {
  const { seerr_url: baseUrl, seerr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Seerr no configurado (pestaña Configuración)');

  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    ...options,
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Seerr ${path} HTTP ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

function mapRequest(r) {
  const mediaType = r.type === 'tv' || r.media?.mediaType === 'tv' ? 'tv' : 'movie';
  return {
    id: r.id,
    status: r.status,
    mediaType,
    tmdbId: r.media?.tmdbId,
    is4k: Boolean(r.is4k),
    seasons: mediaType === 'tv'
      ? (r.seasons || []).map((s) => Number(s.seasonNumber)).filter((n) => Number.isFinite(n) && n > 0)
      : [],
    createdAt: r.createdAt,
    requestedBy: {
      id: r.requestedBy?.id,
      email: r.requestedBy?.email,
      username: r.requestedBy?.plexUsername || r.requestedBy?.jellyfinUsername || r.requestedBy?.username,
    },
  };
}

async function listRequestsByMediaType(filter, mediaType, seerrUserId = null) {
  const results = [];
  let skip = 0;
  for (;;) {
    const requestedBy = seerrUserId ? `&requestedBy=${seerrUserId}` : '';
    const data = await call(
      `/request?filter=${filter}&mediaType=${mediaType}&take=100&skip=${skip}${requestedBy}`
    );
    for (const r of data.results || []) {
      const isTv = r.type === 'tv' || r.media?.mediaType === 'tv';
      const isMovie = r.type === 'movie' || r.media?.mediaType === 'movie';
      if ((mediaType === 'tv' && !isTv) || (mediaType === 'movie' && !isMovie)) continue;
      results.push(mapRequest(r));
    }
    skip += 100;
    if (skip >= (data.pageInfo?.results || 0)) break;
  }
  return results;
}

async function listHistoricalRequestsByMediaType(mediaType, seerrUserId) {
  const results = [];
  let skip = 0;
  for (;;) {
    const data = await call(
      `/request?requestedBy=${seerrUserId}&mediaType=${mediaType}&take=100&skip=${skip}`
    );
    for (const r of data.results || []) {
      const isTv = r.type === 'tv' || r.media?.mediaType === 'tv';
      const isMovie = r.type === 'movie' || r.media?.mediaType === 'movie';
      if ((mediaType === 'tv' && !isTv) || (mediaType === 'movie' && !isMovie)) continue;
      // For history imports, count requests that are already approved or available.
      // Seerr does not return status=5 available items with filter=approved.
      if (!new Set([2, 3, 4, 5]).has(Number(r.status))) continue;
      results.push(mapRequest(r));
    }
    skip += 100;
    if (skip >= (data.pageInfo?.results || 0)) break;
  }
  return results;
}

export async function listPendingRequests() {
  const [movies, shows] = await Promise.all([
    listRequestsByMediaType('pending', 'movie'),
    listRequestsByMediaType('pending', 'tv'),
  ]);
  return [...movies, ...shows].sort((a, b) => a.id - b.id);
}

export async function listPendingMovieRequests() {
  const data = await call('/request?filter=pending&take=100&sort=added&mediaType=movie');
  return (data.results || [])
    .filter((r) => r.type === 'movie' || r.media?.mediaType === 'movie')
    .map(mapRequest);
}

export async function getSeerrUsers() {
  const data = await call('/user?take=200');
  return (data.results || []).map((u) => ({
    id: u.id,
    email: u.email,
    username: u.plexUsername || u.jellyfinUsername || u.username,
    avatar: u.avatar,
  }));
}

// Solicitudes de película de un usuario ya aprobadas (incluye disponibles y en
// proceso), sin importar si pasaron por limitARR o se aprobaron directamente en
// Seerr / venían de antes de instalarlo. Pagina si hace falta.
export async function getApprovedMovieRequestsForUser(seerrUserId) {
  return listRequestsByMediaType('approved', 'movie', seerrUserId);
}

export async function getApprovedRequestsForUser(seerrUserId) {
  const [movies, shows] = await Promise.all([
    listHistoricalRequestsByMediaType('movie', seerrUserId),
    listHistoricalRequestsByMediaType('tv', seerrUserId),
  ]);
  return [...movies, ...shows].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

export async function approveRequest(requestId) {
  await call(`/request/${requestId}/approve`, { method: 'POST' });
}

// Issue #11: rechazar una solicitud en Seerr desde el panel.
export async function declineRequest(requestId) {
  await call(`/request/${requestId}/decline`, { method: 'POST' });
}

export async function getRequest(requestId) {
  return mapRequest(await call(`/request/${requestId}`));
}

// Activa el webhook nativo de Seerr para que avise a limitARR en cuanto entra
// una solicitud (MEDIA_PENDING = 2), en vez de depender solo del sondeo cada
// minuto. El sondeo se deja igualmente como red de seguridad.
export async function configureWebhook(webhookUrl) {
  await call('/settings/notifications/webhook', {
    method: 'POST',
    body: JSON.stringify({
      enabled: true,
      types: 2,
      options: {
        webhookUrl,
        jsonPayload: JSON.stringify({ notification_type: '{{notification_type}}' }),
      },
    }),
  });
}

// Título + póster en una sola llamada (antes eran dos funciones que pedían el
// mismo endpoint por separado). w185 basta para miniaturas del panel.
export async function getMovieDetails(tmdbId) {
  if (!tmdbId) return { title: null, posterUrl: null };
  try {
    const data = await call(`/movie/${tmdbId}`);
    return {
      title: data.title || null,
      posterUrl: data.posterPath ? `https://image.tmdb.org/t/p/w185${data.posterPath}` : null,
    };
  } catch {
    return { title: null, posterUrl: null };
  }
}

export async function getShowDetails(tmdbId, seasonNumber = null) {
  if (!tmdbId) return { title: null, posterUrl: null, showRatingKey: null, seasonStatuses: null };
  try {
    const data = await call(`/tv/${tmdbId}`);
    const season = seasonNumber == null
      ? null
      : (data.seasons || []).find((s) => Number(s.seasonNumber) === Number(seasonNumber));
    const posterPath = season?.posterPath || data.posterPath;
    // Estado por temporada según Seerr (mediaInfo.seasons), para el chequeo de
    // "aún no disponible" también en series. Una temporada que no aparece en
    // mediaInfo (o sin mediaInfo: la serie no está en Plex) queda sin entrada
    // → status 0 → no disponible. seasonStatuses null solo en error de red
    // (catch), que se trata como disponible para no regalar cupo.
    const seasonStatuses = {};
    // Issue #14: fecha aproximada de disponibilidad por temporada. Seerr no la
    // guarda por temporada, así que se usa el updatedAt de la fila de temporada
    // (cambia al pasar a disponible) y de respaldo el mediaAddedAt de la serie.
    const seasonAvailableSince = {};
    for (const s of data.mediaInfo?.seasons || []) {
      const status = Number(s.status ?? 0);
      seasonStatuses[Number(s.seasonNumber)] = status;
      if (status >= 4) {
        const since = Date.parse(s.updatedAt ?? data.mediaInfo?.mediaAddedAt ?? '');
        seasonAvailableSince[Number(s.seasonNumber)] = Number.isFinite(since) ? since : null;
      }
    }
    // Mismo criterio que en películas: el status de Sonarr (queue item) tal
    // cual, no traducido — primer episodio en cola de cada temporada manda.
    const seasonQueueStatus = {};
    for (const d of data.mediaInfo?.downloadStatus || []) {
      const sn = d.episode?.seasonNumber;
      if (sn != null && !(Number(sn) in seasonQueueStatus)) seasonQueueStatus[Number(sn)] = d.status ?? null;
    }
    // Sin nada en cola para ESTA temporada, Sonarr igual sabe por qué (no
    // monitorizada, sin estrenar, faltan episodios) — igual que radarrLabel en
    // movieAvailability. Solo se consulta cuando hace falta (temporada pedida,
    // no disponible, sin cola activa) para no golpear Sonarr en cada búsqueda.
    let sonarrLabel = null;
    if (seasonNumber != null && (seasonStatuses[Number(seasonNumber)] ?? 0) < 4 && !seasonQueueStatus[Number(seasonNumber)]) {
      sonarrLabel = await getSonarrSeasonStatus(data.mediaInfo?.externalServiceId, seasonNumber);
    }
    return {
      title: data.name || null,
      posterUrl: posterPath ? `https://image.tmdb.org/t/p/w185${posterPath}` : null,
      showRatingKey: data.mediaInfo?.ratingKey ? String(data.mediaInfo.ratingKey) : null,
      seasonStatuses,
      seasonAvailableSince,
      seasonQueueStatus,
      sonarrLabel,
    };
  } catch {
    return { title: null, posterUrl: null, showRatingKey: null, seasonStatuses: null, seasonAvailableSince: null, seasonQueueStatus: null, sonarrLabel: null };
  }
}

export async function getMediaDetails(mediaType, tmdbId, seasonNumber = null) {
  if (mediaType === 'tv') return getShowDetails(tmdbId, seasonNumber);
  return getMovieDetails(tmdbId);
}

// "No disponible" (issue #1): una película aprobada que aún no está en Plex no
// resta cupo — el usuario no puede verla todavía. Seerr ya sabe la
// disponibilidad (media.status 4/5 cuando Plex la tiene), así que no hace falta
// conectar Radarr aparte. Ante un error se trata como disponible: en la duda la
// película sigue contando — al revés, un Seerr caído regalaría cupo infinito.
// TTL corto: lo justo para no repetir la misma consulta por cada usuario dentro
// de un ciclo de sondeo, sin retrasar apenas el "ya está en Plex".
const AVAILABILITY_TTL_MS = 60_000;
const availabilityCache = new Map(); // `${tmdbId}:${is4k}` -> { unavailable, availableSince, at }

// Seerr guarda estado y disponibilidad por separado para estándar y 4K
// (`status`/`status4k` en su Media entity) — hay que leer el campo que
// corresponde a la biblioteca de la fila, si no una petición 4K muestra el
// estado de la versión estándar (o al revés).
async function movieAvailability(tmdbId, is4k) {
  const cacheKey = `${tmdbId}:${is4k}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached;

  try {
    const data = await call(`/movie/${tmdbId}`);
    const status = Number((is4k ? data.mediaInfo?.status4k : data.mediaInfo?.status) ?? 0);
    const unavailable = status < 4; // 4 parcial / 5 disponible = ya se puede ver
    // status 3 (PROCESSING) solo significa que Radarr tiene la petición
    // monitorizada — NO que haya una descarga en curso (p.ej. película sin
    // estrenar aún: Radarr la vigila pero no hay nada que bajar todavía). El
    // progreso real de Radarr/Sonarr viene aparte en downloadStatus(4k), que
    // Seerr rellena en vivo consultando la cola; vacío = nada descargando de
    // verdad pase lo que pase el status.
    // El propio `status` de Radarr/Sonarr (queue item), reenviado por Seerr tal
    // cual sin traducir: "downloading", "queued", "paused", "delay", "completed"
    // (importando), "downloadClientUnavailable", "failed", "warning"... null si
    // no hay nada en cola ahora mismo. Esto es lo que pinta la etiqueta, no el
    // status 2/3 de Seerr (que solo dice "solicitada"/"monitorizada").
    const downloadList = is4k ? data.mediaInfo?.downloadStatus4k : data.mediaInfo?.downloadStatus;
    const queueStatus = Array.isArray(downloadList) && downloadList.length > 0 ? downloadList[0].status ?? null : null;
    // Sin nada en cola, Radarr igualmente sabe por qué (en cines pero sin
    // estreno digital, anunciada...) — eso es lo que hay que pintar, no un
    // "pendiente de descarga" genérico nuestro. Opcional (radarr_url/api_key):
    // sin configurar, getRadarrStatus no hace nada y esto queda null.
    let radarrLabel = null;
    if (unavailable && !queueStatus) {
      const radarrId = is4k ? data.mediaInfo?.externalServiceId4k : data.mediaInfo?.externalServiceId;
      radarrLabel = await getRadarrStatus(radarrId);
    }
    // Issue #14: cuándo llegó a Plex (mediaAddedAt de Seerr), para mostrarla en
    // el detalle y contar la caducidad desde ahí en vez de desde la aprobación.
    // Seerr no tiene un mediaAddedAt4k separado, así que se usa el mismo campo
    // para ambas calidades — es la mejor aproximación disponible por API.
    const since = unavailable ? NaN : Date.parse(data.mediaInfo?.mediaAddedAt ?? '');
    const entry = { unavailable, status, queueStatus, radarrLabel, availableSince: Number.isFinite(since) ? since : null, at: Date.now() };
    availabilityCache.set(cacheKey, entry);
    return entry;
  } catch {
    return { unavailable: false, status: null, queueStatus: null, radarrLabel: null, availableSince: null };
  }
}

// Disponibilidad de cada tmdbId según Seerr: si aún no está en Plex y, si ya
// está, desde cuándo. Map tmdbId -> { unavailable, availableSince (ms|null) }.
export async function getMovieAvailability(tmdbIds, is4k = false) {
  const out = new Map();
  for (const tmdbId of new Set(tmdbIds.filter((id) => id != null))) {
    const { unavailable, status, queueStatus, radarrLabel, availableSince } = await movieAvailability(tmdbId, is4k);
    out.set(tmdbId, { unavailable, status, queueStatus, radarrLabel, availableSince });
  }
  return out;
}

// 'gone': Seerr confirma que ya no existe (404 = borrada/cancelada por el usuario).
// 'available': el media ya está disponible (status 4 parcial o 5 completo en Seerr).
// 'pending': existe pero aún no se ha conseguido descargar.
// 'unknown': fallo de red/config/5xx — no se sabe, no se debe actuar sobre esto.
export async function getRequestStatus(requestId) {
  const { seerr_url: baseUrl, seerr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) return 'unknown';

  try {
    const res = await fetch(`${baseUrl}/api/v1/request/${requestId}`, {
      headers: { 'X-Api-Key': apiKey },
    });
    if (res.status === 404) return 'gone';
    if (!res.ok) return 'unknown';

    const data = await res.json();
    return data.media?.status === 4 || data.media?.status === 5 ? 'available' : 'pending';
  } catch {
    return 'unknown';
  }
}
