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
  }));
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
    return { title: row.full_title || row.title, percent: Math.max(0, Math.min(100, percent)) };
  });
}

export async function getUserEpisodeHistory(userId, sectionId, limit = 1000) {
  const data = await call('get_history', {
    user_id: userId,
    section_id: sectionId,
    length: limit,
    media_type: 'episode',
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
    };
  });
}

export async function getSeasonEpisodes(showRatingKey, seasonNumber) {
  if (!showRatingKey || !seasonNumber) return [];
  const seasons = await call('get_children_metadata', { rating_key: showRatingKey });
  const season = (seasons.children_list || []).find(
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
