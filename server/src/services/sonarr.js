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

export async function testSonarrServer() {
  const { sonarr_url: baseUrl, sonarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Sonarr no configurado (pestaña Configuración)');
  const res = await fetch(`${baseUrl}/api/v3/system/status`, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) throw new Error(`Sonarr HTTP ${res.status}`);
}
