import { getRawSetting, setRawSetting, mask } from '../settings.js';

const URL_KEY = 'eliminarr_radarr_url';
const API_KEY_KEY = 'eliminarr_radarr_api_key';

async function call(path, options = {}) {
  const baseUrl = getRawSetting(URL_KEY);
  const apiKey = getRawSetting(API_KEY_KEY);
  if (!baseUrl || !apiKey) throw new Error('Radarr no configurado (pestaña Ajustes de Eliminarr)');

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v3${path}`, {
    ...options,
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Radarr ${path} HTTP ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

export async function ping() {
  await call('/system/status');
  return true;
}

export async function listTags() {
  const tags = await call('/tag');
  return tags.map((t) => ({ id: t.id, label: t.label }));
}

// tagIds vacío/undefined = todo el catálogo.
export async function listMovies({ tagIds } = {}) {
  const movies = await call('/movie');
  const scoped = tagIds && tagIds.length > 0
    ? movies.filter((m) => (m.tags || []).some((t) => tagIds.includes(t)))
    : movies;
  return scoped.map((m) => ({
    id: m.id,
    title: m.title,
    tmdbId: m.tmdbId,
    added: m.added,
    sizeOnDisk: m.sizeOnDisk || 0,
    tags: m.tags || [],
    posterUrl: (m.images || []).find((i) => i.coverType === 'poster')?.remoteUrl || null,
  }));
}

export async function deleteMovie(id, { deleteFiles = true } = {}) {
  await call(`/movie/${id}?deleteFiles=${deleteFiles}&addImportExclusion=false`, { method: 'DELETE' });
}

// Radarr no tiene "añadir un tag" suelto: hay que traer el objeto completo y
// reenviarlo con el tag añadido.
export async function addTag(movieId, tagLabel) {
  const tags = await listTags();
  let tag = tags.find((t) => t.label === tagLabel);
  if (!tag) {
    tag = await call('/tag', { method: 'POST', body: JSON.stringify({ label: tagLabel }) });
  }
  const movie = await call(`/movie/${movieId}`);
  if (movie.tags.includes(tag.id)) return;
  await call(`/movie/${movieId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...movie, tags: [...movie.tags, tag.id] }),
  });
}

export function getConnectionSettings() {
  return { url: getRawSetting(URL_KEY), apiKey: getRawSetting(API_KEY_KEY) };
}

// Vacío = "no cambiar" (mismo criterio que updateSettings en settings.js).
export function setConnectionSettings({ url, apiKey }) {
  if (typeof url === 'string' && url.trim() !== '') setRawSetting(URL_KEY, url.trim().replace(/\/$/, ''));
  if (typeof apiKey === 'string' && apiKey.trim() !== '') setRawSetting(API_KEY_KEY, apiKey.trim());
}

export function getSettingsForDisplay() {
  const { url, apiKey } = getConnectionSettings();
  return { url, api_key_set: Boolean(apiKey), api_key_masked: mask(apiKey) };
}
