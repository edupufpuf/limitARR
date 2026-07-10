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

// Pending movie requests only (series support deferred).
export async function listPendingMovieRequests() {
  const data = await call('/request?filter=pending&take=100&sort=added&mediaType=movie');
  return (data.results || [])
    .filter((r) => r.type === 'movie' || r.media?.mediaType === 'movie')
    .map((r) => ({
      id: r.id,
      tmdbId: r.media?.tmdbId,
      is4k: Boolean(r.is4k),
      requestedBy: {
        id: r.requestedBy?.id,
        email: r.requestedBy?.email,
        username: r.requestedBy?.plexUsername || r.requestedBy?.jellyfinUsername || r.requestedBy?.username,
      },
    }));
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
  const results = [];
  let skip = 0;
  for (;;) {
    const data = await call(
      `/request?requestedBy=${seerrUserId}&filter=approved&mediaType=movie&take=100&skip=${skip}`
    );
    for (const r of data.results || []) {
      if (r.type !== 'movie' && r.media?.mediaType !== 'movie') continue;
      results.push({ id: r.id, tmdbId: r.media?.tmdbId, is4k: Boolean(r.is4k), createdAt: r.createdAt });
    }
    skip += 100;
    if (skip >= (data.pageInfo?.results || 0)) break;
  }
  return results;
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

export async function getMovieTitle(tmdbId) {
  if (!tmdbId) return null;
  try {
    const data = await call(`/movie/${tmdbId}`);
    return data.title || null;
  } catch {
    return null;
  }
}

export async function getMoviePosterUrl(tmdbId) {
  if (!tmdbId) return null;
  try {
    const data = await call(`/movie/${tmdbId}`);
    return data.posterPath ? `https://image.tmdb.org/t/p/w500${data.posterPath}` : null;
  } catch {
    return null;
  }
}

// 'gone': Seerr confirma que ya no existe (404 = borrada/cancelada por el usuario).
// 'available': el media ya está disponible (status 4 parcial o 5 completo en Seerr).
// 'pending': existe pero Radarr aún no lo ha conseguido.
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
