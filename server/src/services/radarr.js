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

export async function testRadarrServer() {
  const { radarr_url: baseUrl, radarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Radarr no configurado (pestaña Configuración)');
  const res = await fetch(`${baseUrl}/api/v3/system/status`, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) throw new Error(`Radarr HTTP ${res.status}`);
}
