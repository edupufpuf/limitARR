import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMovieAvailability, getShowDetails } from '../src/services/seerr.js';
import { updateSettings, setRawSetting } from '../src/settings.js';

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

// Bug real (caso Toy Story 5, sin estrenar): status 3 (PROCESSING) solo dice
// que Radarr monitoriza la petición, no que haya descarga activa. Sin mirar
// downloadStatus (cola real de Radarr/Sonarr) el panel decía "Descargando"
// para algo que ni siquiera se puede empezar a bajar todavía.
test('getMovieAvailability: status 3 sin downloadStatus no trae queueStatus', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url === 'http://seerr.test/api/v1/movie/700') {
      return new Response(JSON.stringify({
        mediaInfo: { status: 3, downloadStatus: [] },
      }), { status: 200 });
    }
    if (url === 'http://seerr.test/api/v1/movie/701') {
      return new Response(JSON.stringify({
        mediaInfo: { status: 3, downloadStatus: [{ status: 'downloading', title: 'X' }] },
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const notYet = await getMovieAvailability([700], false);
    assert.equal(notYet.get(700).status, 3);
    assert.equal(notYet.get(700).queueStatus, null);
    assert.equal(notYet.get(700).unavailable, true);

    const active = await getMovieAvailability([701], false);
    assert.equal(active.get(701).queueStatus, 'downloading');
  } finally {
    global.fetch = originalFetch;
  }
});

// Bug real (caso Toy Story 5): sin nada en cola, se caía a un "pendiente de
// descarga" genérico. La app de Radarr real muestra "Estado: No Disponible"
// para esta película (isAvailable=false) — NO es el status de estreno
// (inCinemas/released), es un campo aparte según isAvailable/monitored/hasFile.
// Verificado contra Radarr real de producción antes de implementar (curl a
// /api/v3/movie/31: isAvailable false, monitored true, hasFile false).
test('getMovieAvailability: con Radarr configurado, usa su "Estado" cuando no hay cola', async () => {
  updateSettings({ radarr_url: 'http://radarr.test', radarr_api_key: 'k' });
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url === 'http://seerr.test/api/v1/movie/800') {
      return new Response(JSON.stringify({
        mediaInfo: { status: 3, downloadStatus: [], externalServiceId: 42 },
      }), { status: 200 });
    }
    if (url === 'http://radarr.test/api/v3/movie/42') {
      return new Response(JSON.stringify({ status: 'inCinemas', isAvailable: false, monitored: true, hasFile: false }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const availability = await getMovieAvailability([800], false);
    assert.equal(availability.get(800).radarrLabel, 'No disponible');
  } finally {
    global.fetch = originalFetch;
    setRawSetting('radarr_url', '');
    setRawSetting('radarr_api_key', '');
  }
});

test('getMovieAvailability: Radarr "Falta" cuando ya cumple isAvailable pero sin archivo', async () => {
  updateSettings({ radarr_url: 'http://radarr.test', radarr_api_key: 'k' });
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url === 'http://seerr.test/api/v1/movie/802') {
      return new Response(JSON.stringify({
        mediaInfo: { status: 3, downloadStatus: [], externalServiceId: 44 },
      }), { status: 200 });
    }
    if (url === 'http://radarr.test/api/v3/movie/44') {
      return new Response(JSON.stringify({ status: 'released', isAvailable: true, monitored: true, hasFile: false }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const availability = await getMovieAvailability([802], false);
    assert.equal(availability.get(802).radarrLabel, 'Falta');
  } finally {
    global.fetch = originalFetch;
    setRawSetting('radarr_url', '');
    setRawSetting('radarr_api_key', '');
  }
});

test('getMovieAvailability: sin Radarr configurado, radarrLabel queda null (no rompe nada)', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url === 'http://seerr.test/api/v1/movie/801') {
      return new Response(JSON.stringify({
        mediaInfo: { status: 3, downloadStatus: [], externalServiceId: 43 },
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`); // si llamara a Radarr, fallaría aquí
  };

  try {
    const availability = await getMovieAvailability([801], false);
    assert.equal(availability.get(801).radarrLabel, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getShowDetails: queueStatus de Sonarr por temporada, vía episode.seasonNumber', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url === 'http://seerr.test/api/v1/tv/900') {
      return new Response(JSON.stringify({
        name: 'La nena',
        seasons: [],
        mediaInfo: {
          seasons: [{ seasonNumber: 1, status: 3 }, { seasonNumber: 2, status: 3 }],
          downloadStatus: [
            { status: 'downloading', episode: { seasonNumber: 1 } },
            { status: 'queued', episode: { seasonNumber: 1 } }, // primer episodio de la temporada manda
          ],
        },
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const details = await getShowDetails(900);
    assert.equal(details.seasonQueueStatus[1], 'downloading');
    assert.equal(details.seasonQueueStatus[2], undefined); // sin cola activa
  } finally {
    global.fetch = originalFetch;
  }
});
