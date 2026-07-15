import { getRawSetting, setRawSetting, mask } from '../settings.js';

const URL_KEY = 'eliminarr_sonarr_url';
const API_KEY_KEY = 'eliminarr_sonarr_api_key';

async function call(path, options = {}) {
  const baseUrl = getRawSetting(URL_KEY);
  const apiKey = getRawSetting(API_KEY_KEY);
  if (!baseUrl || !apiKey) throw new Error('Sonarr no configurado (pestaña Ajustes de Eliminarr)');

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v3${path}`, {
    ...options,
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Sonarr ${path} HTTP ${res.status}`);
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
export async function listSeries({ tagIds } = {}) {
  const series = await call('/series');
  const scoped = tagIds && tagIds.length > 0
    ? series.filter((s) => (s.tags || []).some((t) => tagIds.includes(t)))
    : series;
  return scoped.map((s) => ({
    id: s.id,
    title: s.title,
    tmdbId: s.tmdbId,
    added: s.added,
    sizeOnDisk: s.statistics?.sizeOnDisk || 0,
    tags: s.tags || [],
    posterUrl: (s.images || []).find((i) => i.coverType === 'poster')?.remoteUrl || null,
  }));
}

export async function deleteSeries(id, { deleteFiles = true } = {}) {
  await call(`/series/${id}?deleteFiles=${deleteFiles}&addImportListExclusion=false`, { method: 'DELETE' });
}

// Sonarr, igual que Radarr: no hay "añadir un tag" suelto, hay que reenviar
// el objeto completo con el tag añadido.
export async function addTag(seriesId, tagLabel) {
  const tags = await listTags();
  let tag = tags.find((t) => t.label === tagLabel);
  if (!tag) {
    tag = await call('/tag', { method: 'POST', body: JSON.stringify({ label: tagLabel }) });
  }
  const series = await call(`/series/${seriesId}`);
  if (series.tags.includes(tag.id)) return;
  await call(`/series/${seriesId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...series, tags: [...series.tags, tag.id] }),
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
