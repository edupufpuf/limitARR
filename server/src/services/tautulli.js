import { getSettings } from '../settings.js';

async function call(cmd, params = {}) {
  const { tautulli_url: baseUrl, tautulli_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Tautulli no configurado (pestaña Configuración)');

  const url = new URL(`${baseUrl}/api/v2`);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('cmd', cmd);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tautulli ${cmd} HTTP ${res.status}`);
  const json = await res.json();
  if (json.response?.result !== 'success') {
    throw new Error(`Tautulli ${cmd} failed: ${json.response?.message}`);
  }
  return json.response.data;
}

export async function getMovieLibraries() {
  const data = await call('get_library_names');
  return data
    .filter((lib) => lib.section_type === 'movie')
    .map((lib) => ({ id: Number(lib.section_id), name: lib.section_name, sectionType: lib.section_type }));
}

export async function getLibraries() {
  const data = await call('get_library_names');
  return data
    .filter((lib) => lib.section_type === 'movie' || lib.section_type === 'show')
    .map((lib) => ({ id: Number(lib.section_id), name: lib.section_name, sectionType: lib.section_type }));
}

export async function getUsers() {
  const data = await call('get_users');
  return data.map((u) => ({
    id: Number(u.user_id),
    username: u.username,
    email: u.email,
    friendlyName: u.friendly_name,
    isAdmin: Boolean(Number(u.is_admin)),
  }));
}

// Búsqueda en Plex vía Tautulli, para localizar el rating_key de una película,
// serie o temporada y poder enlazar su página de estadísticas
// (/info?rating_key=X). Devuelve también los guids (incluye "tmdb://<id>", en
// temporadas los de la serie padre) para que el llamante pueda matchear por
// TMDB id en vez de por título, que depende del idioma de la biblioteca.
export async function searchMedia(query) {
  const data = await call('search', { query, limit: 10 });
  const resultsList = data?.results_list || {};
  const mapItem = (m) => ({
    ratingKey: Number(m.rating_key),
    title: m.title,
    parentTitle: m.parent_title || null,
    seasonNumber: m.media_index !== undefined && m.media_index !== '' ? Number(m.media_index) : null,
    guids: [...(m.guids || []), ...(m.parent_guids || [])],
  });
  return {
    movies: (resultsList.movie || []).map(mapItem),
    shows: (resultsList.show || []).map(mapItem),
    seasons: (resultsList.season || []).map(mapItem),
  };
}

// Watch history for a user restricted to one movie library.
// Returns rows with a normalized 0-100 watched percentage each.
export async function getUserMovieHistory(userId, sectionId, limit = 200) {
  const data = await call('get_history', {
    user_id: userId,
    section_id: sectionId,
    length: limit,
    media_type: 'movie',
  });
  return (data.data || []).map((row) => {
    // watched_status: 1 = watched (Tautulli default threshold ~85%), 0.5 = partial, 0 = not watched
    let percent = Number(row.percent_complete);
    if (!Number.isFinite(percent)) {
      percent = Number(row.watched_status) * 100;
    }
    return {
      title: row.full_title || row.title,
      percent: Math.max(0, Math.min(100, percent)),
      date: Number(row.date) ? Number(row.date) * 1000 : null,
    };
  });
}

export async function getUserEpisodeHistory(userId, sectionId, limit = 1000) {
  const data = await call('get_history', {
    user_id: userId,
    section_id: sectionId,
    length: limit,
    media_type: 'episode',
    // Sin esto Tautulli agrupa episodios vistos seguidos (binge) en una sola
    // fila, y solo se ve 1 episodio de la temporada aunque se hayan visto varios.
    grouping: 0,
  });
  return (data.data || []).map((row) => {
    let percent = Number(row.percent_complete);
    if (!Number.isFinite(percent)) {
      percent = Number(row.watched_status) * 100;
    }
    return {
      title: row.full_title || row.title,
      showTitle: row.grandparent_title,
      seasonNumber: Number(row.parent_media_index),
      episodeNumber: Number(row.media_index),
      ratingKey: String(row.rating_key),
      seasonRatingKey: row.parent_rating_key ? String(row.parent_rating_key) : null,
      showRatingKey: row.grandparent_rating_key ? String(row.grandparent_rating_key) : null,
      percent: Math.max(0, Math.min(100, percent)),
      date: Number(row.date) ? Number(row.date) * 1000 : null,
    };
  });
}

// Historial de reproducciones de UN ítem concreto (todas las cuentas), para la
// ventana de detalle de un pendiente: quién lo ha visto, cuándo y hasta qué %.
// Para series el ratingKey guardado puede ser el de la temporada o el de la
// serie entera (ver lookupRatingKey en quota.js): se prueba como temporada y,
// si no devuelve nada, como serie.
export async function getItemWatchHistory(ratingKey, isTv = false) {
  const attempts = isTv
    ? [{ parent_rating_key: ratingKey }, { grandparent_rating_key: ratingKey }]
    : [{ rating_key: ratingKey }];
  for (const params of attempts) {
    const data = await call('get_history', { ...params, length: 500, grouping: 0 });
    const rows = (data.data || []).map((row) => {
      let percent = Number(row.percent_complete);
      if (!Number.isFinite(percent)) {
        percent = Number(row.watched_status) * 100;
      }
      return {
        userId: Number(row.user_id),
        username: row.friendly_name || row.user,
        watchedAt: Number(row.date) ? Number(row.date) * 1000 : null,
        percent: Math.max(0, Math.min(100, percent)),
        // Issue #8: para series, el detalle agrega por temporada y despliega
        // por episodio; en películas estos campos vienen vacíos y se ignoran.
        seasonNumber: row.parent_media_index !== undefined && row.parent_media_index !== '' ? Number(row.parent_media_index) : null,
        episodeNumber: row.media_index !== undefined && row.media_index !== '' ? Number(row.media_index) : null,
        episodeTitle: row.title || null,
      };
    });
    if (rows.length > 0) return rows;
  }
  return [];
}

// Nombre de la serie + número de temporada a partir del rating_key de Plex
// de una temporada. Para el módulo Maintainerr (avisos de borrado de
// series): usa Tautulli, ya configurado y probado, en vez de exigir una
// conexión Plex aparte (plex_url/plex_token) solo para esto — que en la
// práctica se queda sin rellenar y deja el aviso sin serie ni temporada.
export async function getSeasonInfo(ratingKey) {
  if (!ratingKey) return null;
  try {
    const data = await call('get_metadata', { rating_key: ratingKey });
    if (data?.media_type !== 'season') return null;
    const seasonNumber = Number(data.media_index);
    if (!data.parent_title || !Number.isFinite(seasonNumber)) return null;
    return { showTitle: data.parent_title, seasonNumber };
  } catch {
    return null; // sin Tautulli (o rating_key inválido) no se puede nombrar la temporada
  }
}

// Título de una película (u otro ítem) por su rating_key — fallback en vivo
// para el módulo Maintainerr cuando el título del mensaje de Maintainerr no
// se pudo extraer y el proceso ya no tiene la caché en memoria de cuando se
// mandó el aviso (reinicio de por medio). Mismo motivo que getSeasonInfo,
// pero para el caso "no es una temporada".
export async function getMediaTitle(ratingKey) {
  if (!ratingKey) return null;
  try {
    const data = await call('get_metadata', { rating_key: ratingKey });
    return data?.title || null;
  } catch {
    return null;
  }
}

// Sesiones de Plex activas ahora mismo (pedido de Edu, 2 ago 2026: cortar
// duplicados). `started` es un epoch en segundos — se pasa a ms para poder
// comparar con Date.now()/ordenar por antigüedad sin más conversiones.
export async function getActiveSessions() {
  const data = await call('get_activity');
  return (data.sessions || []).map((s) => ({
    sessionKey: s.session_key,
    userId: Number(s.user_id),
    username: s.username,
    title: s.full_title || s.title,
    startedAt: Number(s.started) ? Number(s.started) * 1000 : null,
    state: s.state || null,
    // `session_key` identifica una reproduccion, no el aparato. Tautulli puede
    // mantener dos registros solapados del mismo reproductor y eso no debe
    // parecer un segundo dispositivo.
    machineId: s.machine_id || null,
    player: s.player || null,
    product: s.product || null,
    platform: s.platform || null,
    ipAddress: s.ip_address || null,
  }));
}

export async function terminateSession(sessionKey, message) {
  await call('terminate_session', { session_key: sessionKey, message });
}

export async function getSeasonEpisodes(showRatingKey, seasonNumber) {
  if (!showRatingKey || !seasonNumber) return [];
  const children = await call('get_children_metadata', { rating_key: showRatingKey });
  const childrenList = children.children_list || [];
  // El rating key de respaldo obtenido con search puede ser el de la temporada
  // (cuando Seerr aún no ha enlazado la serie con Plex), no el de la serie.
  // En ese caso get_children_metadata ya devuelve directamente los episodios.
  const directEpisodes = childrenList.filter((item) => item.media_type === 'episode');
  if (directEpisodes.length > 0) {
    return directEpisodes.map((item) => ({
      ratingKey: String(item.rating_key),
      episodeNumber: Number(item.media_index),
      title: item.title,
    }));
  }
  const season = childrenList.find(
    (item) => Number(item.media_index) === Number(seasonNumber)
  );
  if (!season?.rating_key) return [];
  const episodes = await call('get_children_metadata', { rating_key: season.rating_key });
  return (episodes.children_list || [])
    .filter((item) => item.media_type === 'episode')
    .map((item) => ({
      ratingKey: String(item.rating_key),
      episodeNumber: Number(item.media_index),
      title: item.title,
    }));
}
