import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { getWebhookSecret } from '../src/auth.js';
import { getSalvadosByUser, getAllSalvados, pollMaintainerrCollections } from '../src/services/maintainerr.js';

// Tests del módulo Maintainerr con la DB en memoria y global.fetch mockeado
// (estilo eliminarr.test.js: nada de red real, ni Maintainerr ni Telegram).

const app = createApp();
const agent = request.agent(app);

const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);

const COLLECTIONS = [
  {
    id: 1,
    title: 'Peliculas eliminadas en 7 días',
    type: 'movie',
    libraryId: '5',
    deleteAfterDays: 7,
    media: [{ mediaServerId: '9010', tmdbId: 414906, image_path: 'https://img.test/batman.jpg' }],
  },
  {
    id: 4,
    title: 'Peliculas Salvadas por 15 días',
    type: 'movie',
    libraryId: '5',
    deleteAfterDays: 15,
    media: [],
  },
  {
    id: 2,
    title: 'Series eliminadas en 7 dias',
    type: 'season',
    libraryId: '4',
    deleteAfterDays: 7,
    media: [{ mediaServerId: '8501', tmdbId: 292557, image_path: 'https://img.test/show.jpg' }],
  },
  {
    id: 5,
    title: 'Series Salvadas por 7 días',
    type: 'season',
    libraryId: '4',
    deleteAfterDays: 7,
    media: [],
  },
];

const realFetch = global.fetch;
let fetchCalls;

function mockFetch() {
  fetchCalls = [];
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).includes('/api/collections')) {
      const body = String(url).endsWith('/api/collections') ? COLLECTIONS : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (String(url).includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`fetch inesperado en test: ${url}`);
  };
}

before(async () => {
  await agent.post('/api/auth/setup').send({ password: 'secreto-de-test' }).expect(200);
  upsertSetting.run('maintainerr_url', 'http://maintainerr.test:6246');
  upsertSetting.run('maintainerr_bot_token', 'token-de-test');
  upsertSetting.run('maintainerr_chat_id', '-100123');
  upsertSetting.run(
    'maintainerr_salvados_pairs',
    JSON.stringify([
      { source: 'Peliculas eliminadas en 7 días', target: 'Peliculas Salvadas por 15 días' },
      { source: 'Series eliminadas en 7 dias', target: 'Series Salvadas por 7 días' },
    ])
  );
});

afterEach(() => {
  global.fetch = realFetch;
});

test('webhook: secreto malo devuelve 404 y no toca la red', async () => {
  mockFetch();
  await request(app).post('/api/webhook/maintainerr/no-es-el-secreto').send({}).expect(404);
  assert.equal(fetchCalls.length, 0);
});

test('webhook: alta en colección de borrado manda aviso Telegram con botón Salvar', async () => {
  mockFetch();
  await request(app)
    .post(`/api/webhook/maintainerr/${getWebhookSecret()}`)
    .send({
      collectionName: 'Peliculas eliminadas en 7 días',
      message: "'The Batman' has been added to 'Peliculas eliminadas en 7 días'. The item will be handled in 7 days.",
      dayAmount: 7,
      mediaItems: JSON.stringify([{ mediaServerId: '9010' }]),
    })
    .expect(200);

  // El handler sigue en background tras responder; se le da un respiro.
  await new Promise((r) => setTimeout(r, 50));

  const telegram = fetchCalls.find((c) => c.url.includes('api.telegram.org'));
  assert.ok(telegram, 'debería haber llamado a Telegram');
  const payload = JSON.parse(telegram.options.body);
  const text = payload.caption ?? payload.text;
  assert.match(text, /«The Batman» se borrará en 7 días/);
  assert.match(text, /estará 15 días más/);
  assert.equal(
    payload.reply_markup.inline_keyboard[0][0].callback_data,
    'save:9010:1:4'
  );
});

// --- Salvadas para series (siempre por temporada) ---

// Tautulli, no Plex: getSeasonInfo reutiliza la conexión Tautulli ya
// configurada (get_metadata por rating_key) en vez de exigir plex_url/
// plex_token aparte — que en producción se quedaba sin rellenar y dejaba el
// aviso sin serie ni temporada (caso real: fila de salvados con title NULL).
function mockTautulliGetMetadata(cmdHandlers) {
  return async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith('/api/collections')) {
      return new Response(JSON.stringify(COLLECTIONS), { status: 200 });
    }
    if (u.startsWith('http://tautulli.test')) {
      const cmd = new URL(u).searchParams.get('cmd');
      if (cmd in cmdHandlers) return cmdHandlers[cmd](options);
      throw new Error(`unexpected tautulli cmd ${cmd}`);
    }
    if (u.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`fetch inesperado en test: ${u}`);
  };
}

const seasonMetadataResponse = () =>
  new Response(
    JSON.stringify({ response: { result: 'success', data: { media_type: 'season', parent_title: 'Breaking Bad', media_index: 3 } } }),
    { status: 200 }
  );

test('webhook: colección de series nombra serie y temporada explícitas contra Tautulli, no el título compartido del mensaje', async () => {
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');

  const calls = [];
  const baseFetch = mockTautulliGetMetadata({ get_metadata: seasonMetadataResponse });
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return baseFetch(url, options);
  };

  try {
    await request(app)
      .post(`/api/webhook/maintainerr/${getWebhookSecret()}`)
      .send({
        collectionName: 'Series eliminadas en 7 dias',
        // El mensaje de Maintainerr no trae temporada — solo sirve de fallback.
        message: "'Breaking Bad' has been added to 'Series eliminadas en 7 dias'. The item will be handled in 7 days.",
        dayAmount: 7,
        mediaItems: JSON.stringify([{ mediaServerId: '8501' }]),
      })
      .expect(200);

    await new Promise((r) => setTimeout(r, 50));

    const tautulliCall = calls.find((c) => c.url.includes('cmd=get_metadata'));
    assert.ok(tautulliCall, 'debería haber consultado Tautulli por la temporada');

    const telegram = calls.find((c) => c.url.includes('api.telegram.org'));
    const payload = JSON.parse(telegram.options.body);
    const text = payload.caption ?? payload.text;
    assert.match(text, /la serie «Breaking Bad» \(temporada 3\) se borrará en 7 días/);
  } finally {
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }
});

test('webhook: series usa maintainerr_delete_message_tv, no la plantilla de películas', async () => {
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  upsertSetting.run('maintainerr_delete_message_tv', '📺 Serie a punto de irse: {titulo}.');

  const calls = [];
  const baseFetch = mockTautulliGetMetadata({ get_metadata: seasonMetadataResponse });
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return baseFetch(url, options);
  };

  try {
    await request(app)
      .post(`/api/webhook/maintainerr/${getWebhookSecret()}`)
      .send({
        collectionName: 'Series eliminadas en 7 dias',
        message: "'Breaking Bad' has been added to 'Series eliminadas en 7 dias'.",
        dayAmount: 7,
        mediaItems: JSON.stringify([{ mediaServerId: '8501-b' }]),
      })
      .expect(200);
    await new Promise((r) => setTimeout(r, 50));

    const telegram = calls.find((c) => c.url.includes('api.telegram.org'));
    const payload = JSON.parse(telegram.options.body);
    const text = payload.caption ?? payload.text;
    assert.match(text, /📺 Serie a punto de irse: la serie «Breaking Bad» \(temporada 3\)\./);
  } finally {
    db.prepare("DELETE FROM settings WHERE key IN ('maintainerr_delete_message_tv', 'tautulli_url', 'tautulli_api_key')").run();
  }
});

test('webhook: temporada sin Tautulli configurado cae al título del mensaje, sin reventar', async () => {
  db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();

  const calls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.endsWith('/api/collections')) {
      return new Response(JSON.stringify(COLLECTIONS), { status: 200 });
    }
    if (u.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`fetch inesperado en test: ${u}`);
  };

  await request(app)
    .post(`/api/webhook/maintainerr/${getWebhookSecret()}`)
    .send({
      collectionName: 'Series eliminadas en 7 dias',
      message: "'Breaking Bad' has been added to 'Series eliminadas en 7 dias'. The item will be handled in 7 days.",
      dayAmount: 7,
      mediaItems: JSON.stringify([{ mediaServerId: '8501' }]),
    })
    .expect(200);

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(calls.some((c) => c.url.includes('cmd=get_metadata')), false);
  const telegram = calls.find((c) => c.url.includes('api.telegram.org'));
  const payload = JSON.parse(telegram.options.body);
  const text = payload.caption ?? payload.text;
  assert.match(text, /«Breaking Bad» se borrará en 7 días/);
});

// --- Sondeo de respaldo: altas manuales que Maintainerr no notifica solo ---

test('pollMaintainerrCollections: avisa de un ítem manual que el webhook nunca notificó, y no lo repite', async () => {
  // Por si un test anterior (el webhook normal) ya marcó 9010 como avisado.
  db.prepare("DELETE FROM maintainerr_notified WHERE media_server_id = '9010' AND collection_id = 1").run();

  const calls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.endsWith('/api/collections')) {
      return new Response(JSON.stringify(COLLECTIONS), { status: 200 });
    }
    if (u.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`fetch inesperado en test: ${u}`);
  };

  // mediaServerId 9010 (The Batman) ya está en COLLECTIONS (colección movie,
  // id 1) pero nunca se marcó como avisado — simula una alta manual.
  await pollMaintainerrCollections();
  const telegramCalls = calls.filter((c) => c.url.includes('api.telegram.org'));
  assert.equal(telegramCalls.length, 1);

  const marked = db.prepare('SELECT 1 FROM maintainerr_notified WHERE media_server_id = ? AND collection_id = 1').get('9010');
  assert.ok(marked, 'debería quedar marcado como avisado');

  // Segunda pasada: mismo estado de la colección, no debería volver a avisar.
  await pollMaintainerrCollections();
  assert.equal(calls.filter((c) => c.url.includes('api.telegram.org')).length, 1);
});

test('pollMaintainerrCollections: si el ítem sale de la colección, se limpia la marca (avisaría de nuevo si vuelve)', async () => {
  db.prepare("INSERT OR IGNORE INTO maintainerr_notified (media_server_id, collection_id) VALUES ('9099', 1)").run();

  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/collections')) {
      return new Response(JSON.stringify(COLLECTIONS), { status: 200 }); // 9099 no está en su media[]
    }
    throw new Error(`fetch inesperado en test: ${u}`);
  };

  await pollMaintainerrCollections();
  const marked = db.prepare("SELECT 1 FROM maintainerr_notified WHERE media_server_id = '9099' AND collection_id = 1").get();
  assert.equal(marked, undefined);
});

test('webhook: alta en la propia colección de salvados se ignora (sin bucle)', async () => {
  mockFetch();
  await request(app)
    .post(`/api/webhook/maintainerr/${getWebhookSecret()}`)
    .send({
      collectionName: 'Peliculas Salvadas por 15 días',
      mediaItems: JSON.stringify([{ mediaServerId: '9010' }]),
    })
    .expect(200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fetchCalls.filter((c) => c.url.includes('api.telegram.org')).length, 0);
});

test('salvados: registro consultable por usuario y en total, caducados fuera', async () => {
  db.prepare('DELETE FROM salvados').run();
  const insert = db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, saved_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `);
  insert.run('9010', 414906, 'The Batman', '111', 'Jesús', 1880, "datetime('now')");
  db.prepare("UPDATE salvados SET expires_at = datetime('now', '+15 days') WHERE media_server_id = '9010'").run();
  insert.run('9011', 550, 'Fight Club', '222', 'Amparo', 1880, "x");
  db.prepare("UPDATE salvados SET expires_at = datetime('now', '-1 day') WHERE media_server_id = '9011'").run();

  // Sin mockFetch en este test, la comprobación en vivo contra Maintainerr
  // falla (host de prueba inexistente) y filterStillInCollection hace
  // fail-open: se queda solo con el filtro de expires_at, como antes.
  const own = await getSalvadosByUser(1880);
  assert.equal(own.length, 1);
  assert.equal(own[0].title, 'The Batman');
  assert.equal((await getAllSalvados()).length, 1);
});

test('salvados: se descarta si ya no está en la colección de Maintainerr aunque no haya caducado', async () => {
  db.prepare('DELETE FROM salvados').run();
  db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, saved_at, expires_at)
    VALUES ('9010', 414906, 'The Batman', '111', 'Jesús', 1880, datetime('now'), datetime('now', '+15 days'))
  `).run();

  // El admin la sacó a mano de la colección de salvados en Maintainerr: la
  // colección target (id 4, en COLLECTIONS) ya no trae ese mediaServerId en
  // su media[], aunque expires_at todavía esté lejos.
  global.fetch = async (url) => {
    if (String(url).endsWith('/api/collections')) {
      return new Response(JSON.stringify(COLLECTIONS), { status: 200 });
    }
    throw new Error(`fetch inesperado en test: ${url}`);
  };

  assert.equal((await getSalvadosByUser(1880)).length, 0);
  assert.equal((await getAllSalvados()).length, 0);
});

test('endpoints admin: /salvados y settings del módulo responden', async () => {
  const salvados = await agent.get('/api/salvados').expect(200);
  assert.ok(Array.isArray(salvados.body));

  const settings = await agent.get('/api/maintainerr/settings').expect(200);
  assert.equal(settings.body.enabled, true);
  assert.match(settings.body.webhookUrl, /\/api\/webhook\/maintainerr\//);
  assert.equal(settings.body.bot_token_set, true);
});
