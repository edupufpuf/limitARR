import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMovieAvailability } from '../src/services/seerr.js';
import { updateSettings } from '../src/settings.js';

updateSettings({ seerr_url: 'http://seerr.test', seerr_api_key: 'k' });

// Bug real: una petición en biblioteca 4K mostraba el estado de la versión
// estándar (o al revés), porque siempre se leía mediaInfo.status y nunca
// mediaInfo.status4k. Seerr los guarda como campos separados por película.
test('getMovieAvailability: usa status4k para bibliotecas 4K, status para estándar', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url === 'http://seerr.test/api/v1/movie/603') {
      return new Response(JSON.stringify({
        mediaInfo: { status: 5, status4k: 3, mediaAddedAt: '2026-07-01T00:00:00Z' },
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const standard = await getMovieAvailability([603], false);
    assert.equal(standard.get(603).unavailable, false); // status 5 = disponible
    assert.equal(standard.get(603).status, 5);

    const fourK = await getMovieAvailability([603], true);
    assert.equal(fourK.get(603).unavailable, true); // status4k 3 = procesando, no disponible
    assert.equal(fourK.get(603).status, 3);
  } finally {
    global.fetch = originalFetch;
  }
});
