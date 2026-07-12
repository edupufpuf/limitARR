import { getSettings } from '../settings.js';

// Radarr es opcional (issue #1): sin URL + API key configuradas, el cupo
// funciona como siempre (toda aprobada no vista cuenta). Con Radarr conectado,
// una película que aún no tiene fichero no resta cupo: el usuario no puede
// verla todavía, así que no debe ocupar hueco mientras tanto.

export function radarrConfigured() {
  const { radarr_url: url, radarr_api_key: key } = getSettings();
  return Boolean(url && key);
}

async function call(path) {
  const { radarr_url: baseUrl, radarr_api_key: apiKey } = getSettings();
  if (!baseUrl || !apiKey) throw new Error('Radarr no configurado (pestaña Configuración)');

  const res = await fetch(`${baseUrl}/api/v3${path}`, {
    headers: { 'X-Api-Key': apiKey },
  });
  if (!res.ok) throw new Error(`Radarr ${path} HTTP ${res.status}`);
  return res.json();
}

// Para "Probar conexión" en Configuración.
export async function ping() {
  await call('/system/status');
}

// TTL corto: lo justo para no repetir la misma consulta por cada usuario dentro
// de un ciclo de sondeo, sin retrasar apenas el "ya se ha descargado".
const CACHE_TTL_MS = 60_000;
const availabilityCache = new Map(); // tmdbId -> { unavailable, at }

// hasFile es lo único que importa para el cupo: cubre por igual los tres
// subestados de "No disponible" en Radarr (faltante, sin estrenar, no
// encontrada — este último cuando Radarr ni siquiera conoce la película).
// Ante un error se trata como disponible: en la duda la película sigue
// contando — al revés, un Radarr caído regalaría cupo infinito.
async function isUnavailable(tmdbId) {
  const cached = availabilityCache.get(tmdbId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.unavailable;

  try {
    const movies = await call(`/movie?tmdbId=${tmdbId}`);
    const unavailable = !(Array.isArray(movies) && movies.some((m) => m.hasFile));
    availabilityCache.set(tmdbId, { unavailable, at: Date.now() });
    return unavailable;
  } catch {
    return false;
  }
}

// Subconjunto de `tmdbIds` sin fichero en Radarr. Set vacío si Radarr no está
// configurado — el resto del código no necesita saber si la integración existe.
export async function getUnavailableTmdbIds(tmdbIds) {
  const out = new Set();
  if (!radarrConfigured()) return out;
  for (const tmdbId of new Set(tmdbIds.filter((id) => id != null))) {
    if (await isUnavailable(tmdbId)) out.add(tmdbId);
  }
  return out;
}
