import { getSettings } from '../settings.js';

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
  if (!tmdbId) return { title: null, posterUrl: null, showRatingKey: null };
  try {
    const data = await call(`/tv/${tmdbId}`);
    const season = seasonNumber == null
      ? null
      : (data.seasons || []).find((s) => Number(s.seasonNumber) === Number(seasonNumber));
    const posterPath = season?.posterPath || data.posterPath;
    return {
      title: data.name || null,
      posterUrl: posterPath ? `https://image.tmdb.org/t/p/w185${posterPath}` : null,
      showRatingKey: data.mediaInfo?.ratingKey ? String(data.mediaInfo.ratingKey) : null,
    };
  } catch {
    return { title: null, posterUrl: null, showRatingKey: null };
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
const availabilityCache = new Map(); // tmdbId -> { unavailable, at }

async function isUnavailable(tmdbId) {
  const cached = availabilityCache.get(tmdbId);
  if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.unavailable;

  try {
    const data = await call(`/movie/${tmdbId}`);
    const status = Number(data.mediaInfo?.status ?? 0);
    const unavailable = status < 4; // 4 parcial / 5 disponible = ya se puede ver
    availabilityCache.set(tmdbId, { unavailable, at: Date.now() });
    return unavailable;
  } catch {
    return false;
  }
}

// Subconjunto de `tmdbIds` que aún no están disponibles en Plex según Seerr.
export async function getUnavailableTmdbIds(tmdbIds) {
  const out = new Set();
  for (const tmdbId of new Set(tmdbIds.filter((id) => id != null))) {
    if (await isUnavailable(tmdbId)) out.add(tmdbId);
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
