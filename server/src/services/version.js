import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

const IMAGE = 'edupufpuf/limitarr';
const CHECK_TTL_MS = 30 * 60 * 1000;

// GIT_SHA lo hornea el workflow como build-arg; en desarrollo local no existe
// y el panel muestra "dev" sin comprobar actualizaciones.
export const currentSha = process.env.GIT_SHA || null;

let cache = { checkedAt: 0, latestSha: null };

async function ghcr(path, token, accept) {
  const res = await fetch(`https://ghcr.io/v2/${IMAGE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
  });
  if (!res.ok) throw new Error(`ghcr ${path} -> ${res.status}`);
  return res.json();
}

// SHA del commit con el que se construyó la imagen `latest` publicada en GHCR,
// leído del label org.opencontainers.image.revision que añade el workflow:
// token anónimo de pull -> manifest de `latest` -> blob de config -> labels.
// El repo de GitHub es privado, pero el paquete GHCR es público, así que esta
// es la única fuente consultable desde el servidor sin credenciales.
async function fetchLatestSha() {
  const tokenRes = await fetch(`https://ghcr.io/token?scope=repository:${IMAGE}:pull`);
  if (!tokenRes.ok) throw new Error(`ghcr token -> ${tokenRes.status}`);
  const { token } = await tokenRes.json();

  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');

  let manifest = await ghcr('/manifests/latest', token, accept);

  // buildx publica un índice OCI cuyos manifiestos de atestación llevan
  // platform unknown/unknown; hay que bajar al manifiesto real de la imagen.
  if (manifest.manifests) {
    const img = manifest.manifests.find((m) => m.platform && m.platform.os !== 'unknown');
    if (!img) throw new Error('ghcr: index sin manifiesto de imagen');
    manifest = await ghcr(`/manifests/${img.digest}`, token, accept);
  }

  const config = await ghcr(`/blobs/${manifest.config.digest}`, token, '*/*');
  return config.config?.Labels?.['org.opencontainers.image.revision'] ?? null;
}

export async function getVersionInfo() {
  const info = {
    version: pkg.version,
    sha: currentSha ? currentSha.slice(0, 7) : null,
  };
  if (!currentSha) return { ...info, latestSha: null, updateAvailable: null };

  if (Date.now() - cache.checkedAt > CHECK_TTL_MS) {
    try {
      cache = { checkedAt: Date.now(), latestSha: await fetchLatestSha() };
    } catch (err) {
      // Sin red o GHCR caído: se recuerda el intento para no reintentar en
      // cada carga del panel, y updateAvailable queda en null (no se avisa).
      console.error('[version] no se pudo comprobar GHCR:', err.message);
      cache = { checkedAt: Date.now(), latestSha: null };
    }
  }

  return {
    ...info,
    latestSha: cache.latestSha ? cache.latestSha.slice(0, 7) : null,
    updateAvailable: cache.latestSha ? cache.latestSha !== currentSha : null,
  };
}
