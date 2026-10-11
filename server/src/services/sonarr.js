import { getSettings } from '../settings.js';

// Integración de solo lectura, igual que radarr.js: solo para la etiqueta de
// una temporada cuando Seerr no tiene nada en cola, deliberadamente separada
// del cálculo del cupo (que sigue sin Radarr/Sonarr por diseño).
async function call(path) {
  const { sonarr_url: baseUrl, sonarr_api_key: apiKey } = getSettings();
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
  const { sonarr_url: baseUrl, sonarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Sonarr no configurado');
  const res = await fetch(`${baseUrl}/api/v3${path}`, {
    method,
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sonarr ${method} ${path} HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export async function setSonarrSeasonMonitored(seriesId, seasonNumber, monitored) {
  if (seriesId == null || seasonNumber == null) return null;
  const series = await call(`/series/${seriesId}`);
  if (!series) return null;
  const season = (series.seasons || []).find((row) => Number(row.seasonNumber) === Number(seasonNumber));
  if (!season) return null;
  if (Boolean(season.monitored) !== Boolean(monitored)) {
    season.monitored = Boolean(monitored);
    await write(`/series/${series.id}`, 'PUT', series);
  }
  return series.id;
}

export async function getSonarrWaitState(seriesId, seasonNumber, { checkReleases = true } = {}) {
  if (seriesId == null) return { externalServiceId: null, downloaded: false, downloading: false, releaseAvailable: false };
  const series = await call(`/series/${seriesId}`);
  const season = series?.seasons?.find((row) => Number(row.seasonNumber) === Number(seasonNumber));
  if (!series || !season) return { externalServiceId: seriesId, downloaded: false, downloading: false, releaseAvailable: false };
  const downloaded = Number(season.statistics?.episodeFileCount ?? 0) > 0;
  const queue = await call('/queue?page=1&pageSize=100&includeUnknownSeriesItems=true');
  const downloading = (queue?.records || []).some((row) =>
    Number(row.seriesId) === Number(series.id) && Number(row.episode?.seasonNumber) === Number(seasonNumber)
  );
  let releaseAvailable = false;
  if (checkReleases && !downloaded && !downloading) {
    const releases = await call(`/release?seriesId=${series.id}&seasonNumber=${seasonNumber}`);
    releaseAvailable = Array.isArray(releases) && releases.some((release) => (release.rejections || []).length === 0);
  }
  return { externalServiceId: series.id, downloaded, downloading, releaseAvailable };
}

export async function searchSonarrSeason(seriesId, seasonNumber) {
  const id = await setSonarrSeasonMonitored(seriesId, seasonNumber, true);
  if (id == null) throw new Error(`temporada ${seasonNumber} no encontrada en Sonarr`);
  await write('/command', 'POST', { name: 'SeasonSearch', seriesId: id, seasonNumber });
  return id;
}

// A diferencia de Radarr (que sí tiene un campo "Estado" único por película),
// Sonarr no tiene un equivalente por temporada en su API/app — hay que
// derivarlo de sus propias estadísticas (statistics.episodeFileCount,
// previousAiring/nextAiring, monitored). Verificado contra el Sonarr de
// producción: serie "Silo" temporada 2, monitored=false, 0/10 episodios, sin
// previousAiring/nextAiring — por eso el orden de comprobación es ese primero.
export async function getSonarrSeasonStatus(sonarrSeriesId, seasonNumber) {
  if (sonarrSeriesId == null || seasonNumber == null) return null;
  const series = await call(`/series/${sonarrSeriesId}`);
  const season = series?.seasons?.find((s) => Number(s.seasonNumber) === Number(seasonNumber));
  if (!season) return null;
  const stats = season.statistics ?? {};
  if (stats.episodeFileCount > 0) return null; // ya hay algún archivo, cuenta como disponible vía Seerr
  if (!season.monitored) return 'No monitorizada';
  if (!stats.previousAiring && !stats.nextAiring) return 'Sin estrenar';
  return 'Faltan episodios';
}

// Issue #22 (jesusgarrigues): botón "Ver en Sonarr" en la ventana de detalle.
// A diferencia de Radarr, Sonarr no indexa por tmdbId (usa tvdbId, que
// limitARR no guarda) — hace falta el id interno de Sonarr, que llega vía
// Seerr (mediaInfo.externalServiceId, ver getSonarrSeriesId en seerr.js).
export async function getSonarrSeriesUrl(sonarrSeriesId) {
  const { sonarr_url: baseUrl } = getSettings();
  if (!baseUrl || sonarrSeriesId == null) return null;
  const series = await call(`/series/${sonarrSeriesId}`);
  if (!series) return null;
  return `${baseUrl}/series/${series.titleSlug ?? series.id}`;
}

export async function testSonarrServer() {
  const { sonarr_url: baseUrl, sonarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Sonarr no configurado (pestaña Configuración)');
  const res = await fetch(`${baseUrl}/api/v3/system/status`, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) throw new Error(`Sonarr HTTP ${res.status}`);
}
