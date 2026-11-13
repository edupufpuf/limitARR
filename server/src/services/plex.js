import crypto from 'node:crypto';
import { getRawSetting, setRawSetting, getSettings } from '../settings.js';

const CLIENT_ID_KEY = 'plex_client_identifier';
const PRODUCT = 'limitARR';
const LIBRARY_CACHE_MS = 5 * 60 * 1000;
const libraryCache = new Map();
const childrenCache = new Map();

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

function localPlexUrl(pathname) {
  const { plex_url: baseUrl, plex_token: token } = getSettings();
  if (!baseUrl || !token) throw new Error('Plex no configurado');
  const url = new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`);
  url.searchParams.set('X-Plex-Token', token);
  return url;
}

async function cached(cache, key, load) {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = await load();
  cache.set(key, { value, expiresAt: Date.now() + LIBRARY_CACHE_MS });
  return value;
}

export async function getPlexLibraryMedia(sectionId) {
  const { plex_url: baseUrl } = getSettings();
  const key = `${baseUrl || ''}:${sectionId}`;
  return cached(libraryCache, key, async () => {
    const data = await plexFetch(localPlexUrl(`/library/sections/${sectionId}/all?includeGuids=1`));
    return (data?.MediaContainer?.Metadata || []).map((item) => ({
      ratingKey: String(item.ratingKey),
      title: item.title,
      mediaType: item.type,
      guids: (item.Guid || []).map((guid) => guid.id),
    }));
  });
}

export async function getPlexMediaChildren(ratingKey) {
  const { plex_url: baseUrl } = getSettings();
  const key = `${baseUrl || ''}:${ratingKey}`;
  return cached(childrenCache, key, async () => {
    const data = await plexFetch(localPlexUrl(`/library/metadata/${ratingKey}/children`));
    return (data?.MediaContainer?.Metadata || []).map((item) => ({
      ratingKey: String(item.ratingKey),
      title: item.title,
      mediaType: item.type,
      seasonNumber: item.index !== undefined && item.index !== '' ? Number(item.index) : null,
    }));
  });
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
// Para temporadas no basta con que siga existiendo la ficha: Plex puede
// conservarla vacía después de que Sonarr borre todos sus episodios.
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
    const metadata = data?.MediaContainer?.Metadata ?? [];
    if (metadata.length === 0) return false;

    if (metadata[0]?.type === 'season') {
      const childrenRes = await fetch(
        `${baseUrl.replace(/\/$/, '')}/library/metadata/${ratingKey}/children`,
        { headers: { Accept: 'application/json', 'X-Plex-Token': token } }
      );
      if (childrenRes.status === 404) return false;
      if (!childrenRes.ok) return null;
      const children = await childrenRes.json();
      return Boolean(children?.MediaContainer?.Metadata?.length);
    }

    return true;
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
