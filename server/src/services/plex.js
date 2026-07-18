import crypto from 'node:crypto';
import { getRawSetting, setRawSetting, getSettings } from '../settings.js';

const CLIENT_ID_KEY = 'plex_client_identifier';
const PRODUCT = 'limitARR';

function headers() {
  let clientId = getRawSetting(CLIENT_ID_KEY);
  if (!clientId) {
    clientId = `limitarr-${crypto.randomUUID()}`;
    setRawSetting(CLIENT_ID_KEY, clientId);
  }
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Client-Identifier': clientId,
  };
}

async function plexFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...headers(), ...options.headers } });
  if (!res.ok) throw new Error(`Plex HTTP ${res.status}`);
  return res.json();
}

export async function createPlexPin(forwardUrl) {
  const pin = await plexFetch('https://plex.tv/api/v2/pins?strong=true', { method: 'POST' });
  const query = new URLSearchParams({
    clientID: headers()['X-Plex-Client-Identifier'],
    code: pin.code,
    forwardUrl,
    'context[device][product]': PRODUCT,
  });
  return { id: pin.id, authUrl: `https://app.plex.tv/auth#?${query}` };
}

export async function claimPlexPin(id) {
  const pin = await plexFetch(`https://plex.tv/api/v2/pins/${encodeURIComponent(id)}`);
  return pin.authToken || null;
}

export async function getPlexAccount(token) {
  return plexFetch('https://plex.tv/api/v2/user', {
    headers: { 'X-Plex-Token': token },
  });
}

// Metadato de un ítem de Plex por su ratingKey. Lo usa el módulo Maintainerr
// para resolver serie+temporada de un "media" de una colección de tipo
// season: Maintainerr no manda seasonNumber ni el título de la serie suelto,
// solo tmdbId (a nivel de serie) e image_path — parentTitle/index de Plex sí
// distinguen una temporada de otra. Sin Plex configurado o si falla, null:
// el llamante cae a lo que tenga (el título del mensaje de Maintainerr).
export async function getPlexMetadata(ratingKey) {
  const { plex_url: baseUrl, plex_token: token } = getSettings();
  if (!baseUrl || !token) return null;
  try {
    const data = await plexFetch(`${baseUrl.replace(/\/$/, '')}/library/metadata/${ratingKey}`, {
      headers: { 'X-Plex-Token': token },
    });
    return data.MediaContainer?.Metadata?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function testPlexServer(baseUrl, token) {
  if (!baseUrl || !token) throw new Error('Plex no configurado');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/identity`, {
    headers: { Accept: 'application/json', 'X-Plex-Token': token },
  });
  if (!res.ok) throw new Error(`Plex HTTP ${res.status}`);
  return res.json();
}
