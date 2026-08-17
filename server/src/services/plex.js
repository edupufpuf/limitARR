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

// Pedido de Edu (17 ago 2026): salir de la colección de borrado de Maintainerr
// NO significa que se haya borrado — Maintainerr también saca un ítem de la
// colección cuando deja de cumplir la regla (p.ej. alguien la ha vuelto a ver,
// resetea el "sin ver hace N días"), sin borrar nada. pollMaintainerrCollections
// (maintainerr.js) confundía ambos casos y marcaba "YA BORRADA" una película
// que seguía intacta en Plex. Consulta directa al Plex local (no plex.tv) por
// ratingKey: 200 con Metadata = sigue ahí, 404 = de verdad ha desaparecido.
export async function mediaExistsInPlex(ratingKey) {
  const { plex_url: baseUrl, plex_token: token } = getSettings();
  if (!baseUrl || !token || !ratingKey) return null; // sin datos para decidir, no se sabe
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/library/metadata/${ratingKey}`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
    });
    if (res.status === 404) return false;
    if (!res.ok) return null; // error de red/servidor: no se sabe, mejor no marcar borrada a lo tonto
    const data = await res.json();
    return Boolean(data?.MediaContainer?.Metadata?.length);
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
