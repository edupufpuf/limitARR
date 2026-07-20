import { getSettings } from '../settings.js';

// Integración de solo lectura, y solo para UNA cosa: cuando Seerr no tiene
// nada en cola (ver queueStatus en seerr.js), Radarr sigue sabiendo por qué —
// "En cines" pero sin estreno digital, "Anunciada", etc. Deliberadamente NO se
// reintroduce Radarr en el cálculo del cupo (se sacó el 12 jul 2026 para
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

// MovieStatus de Radarr (mismo texto que su propia ficha, en vez de un genérico
// "pendiente" nuestro): tba/announced/inCinemas/released/deleted.
const STATUS_LABEL = {
  tba: 'Por anunciar',
  announced: 'Anunciada',
  inCinemas: 'En cines',
  released: 'Estrenada',
  deleted: 'Eliminada',
};

export async function getRadarrStatus(radarrId) {
  if (radarrId == null) return null;
  const movie = await call(`/movie/${radarrId}`);
  if (!movie || movie.hasFile) return null; // con archivo ya es "disponible" vía Seerr
  return STATUS_LABEL[movie.status] ?? null;
}

export async function testRadarrServer() {
  const { radarr_url: baseUrl, radarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Radarr no configurado (pestaña Configuración)');
  const res = await fetch(`${baseUrl}/api/v3/system/status`, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) throw new Error(`Radarr HTTP ${res.status}`);
}
