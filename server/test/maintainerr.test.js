import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { getWebhookSecret } from '../src/auth.js';
import { getSalvadosByUser, getAllSalvados, getSalvadosHistory, pollMaintainerrCollections, processSalvados } from '../src/services/maintainerr.js';

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
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: -100123 } } }), { status: 200 });
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
    'asksave:9010:1:4'
  );

  // Guardado para poder editarlo luego (quitar el botón + "YA BORRADA" si
  // Maintainerr lo borra de verdad sin que nadie pulse Salvar).
  const stored = db.prepare(
    "SELECT * FROM maintainerr_messages WHERE media_server_id = '9010' AND collection_id = 1"
  ).get();
  assert.ok(stored, 'debe guardar el mensaje mandado');
  assert.equal(stored.chat_id, '-100123');
  assert.equal(stored.message_id, 1);
  assert.equal(stored.has_photo, 1);
  assert.equal(stored.text, text);
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
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: -100123 } } }), { status: 200 });
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
    // '8501-b' no existe en COLLECTIONS.media (fixture): sin este cleanup,
    // pollMaintainerrCollections lo vería "salir" de la colección en el
    // siguiente test y dispararía un aviso real de "YA BORRADA".
    db.prepare("DELETE FROM maintainerr_notified WHERE media_server_id = '8501-b'").run();
    db.prepare("DELETE FROM maintainerr_messages WHERE media_server_id = '8501-b'").run();
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
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: -100123 } } }), { status: 200 });
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

test('webhook: película sin título extraíble del mensaje se resuelve por Tautulli en vez de quedarse sin título', async () => {
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');

  const calls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.endsWith('/api/collections')) {
      return new Response(JSON.stringify(COLLECTIONS), { status: 200 });
    }
    if (u.startsWith('http://tautulli.test')) {
      const cmd = new URL(u).searchParams.get('cmd');
      if (cmd === 'get_metadata') {
        return new Response(
          JSON.stringify({ response: { result: 'success', data: { media_type: 'movie', title: 'The Batman' } } }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected tautulli cmd ${cmd}`);
    }
    if (u.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: -100123 } } }), { status: 200 });
    }
    throw new Error(`fetch inesperado en test: ${u}`);
  };

  try {
    await request(app)
      .post(`/api/webhook/maintainerr/${getWebhookSecret()}`)
      .send({
        collectionName: 'Peliculas eliminadas en 7 días',
        // Sin comillas: el regex del título no matchea nada.
        message: 'A new item has been handled.',
        dayAmount: 7,
        mediaItems: JSON.stringify([{ mediaServerId: '9010' }]),
      })
      .expect(200);
    await new Promise((r) => setTimeout(r, 50));

    const tautulliCall = calls.find((c) => c.url.includes('cmd=get_metadata'));
    assert.ok(tautulliCall, 'debería haber consultado Tautulli por el título');

    const telegram = calls.find((c) => c.url.includes('api.telegram.org'));
    const payload = JSON.parse(telegram.options.body);
    const text = payload.caption ?? payload.text;
    assert.match(text, /«The Batman» se borrará en 7 días/);
  } finally {
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }
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
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: -100123 } } }), { status: 200 });
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

// Pedido de Edu (4 ago 2026): si el ítem sale de su colección de borrado sin
// haber pasado por el botón Salvar, es que Maintainerr lo borró de verdad —
// el aviso original debe perder el botón y ganar "YA BORRADA".
test('pollMaintainerrCollections: ítem borrado de verdad (no salvado) marca el aviso original como YA BORRADA', async () => {
  db.prepare("INSERT OR IGNORE INTO maintainerr_notified (media_server_id, collection_id) VALUES ('9098', 1)").run();
  db.prepare(`
    INSERT INTO maintainerr_messages (media_server_id, collection_id, chat_id, message_id, has_photo, text)
    VALUES ('9098', 1, '-100123', 555, 1, '🎬 «Batman Begins» se borrará en 7 días.')
  `).run();

  const calls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.endsWith('/api/collections')) {
      return new Response(JSON.stringify(COLLECTIONS), { status: 200 }); // 9098 no está en su media[]: ya no existe
    }
    if (u.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 555, chat: { id: -100123 } } }), { status: 200 });
    }
    throw new Error(`fetch inesperado en test: ${u}`);
  };

  await pollMaintainerrCollections();

  const editCall = calls.find((c) => c.url.includes('/editMessageCaption'));
  assert.ok(editCall, 'debe editar el mensaje original (tenía foto: caption, no text)');
  const payload = JSON.parse(editCall.options.body);
  assert.equal(payload.chat_id, '-100123');
  assert.equal(payload.message_id, 555);
  assert.match(payload.caption, /🎬 «Batman Begins» se borrará en 7 días\./);
  assert.match(payload.caption, /YA BORRADA/);
  assert.deepEqual(payload.reply_markup, { inline_keyboard: [] });

  const messageRow = db.prepare("SELECT 1 FROM maintainerr_messages WHERE media_server_id = '9098' AND collection_id = 1").get();
  assert.equal(messageRow, undefined, 'la fila se borra tras marcarlo');
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

// --- processSalvados: borrado ligado a visionado (8 ago 2026) ---

const insertCandidateRow = db.prepare(`
  INSERT INTO maintainerr_candidates (media_server_id, notified_at, delete_after_days, window_closed_notified)
  VALUES (?, ?, ?, ?)
`);
const insertSalvadoMessageRow = db.prepare(`
  INSERT INTO salvado_messages (media_server_id, chat_id, message_id, has_photo, text) VALUES (?, '-100123', 777, 0, ?)
`);

function targetCollectionsFetch(mediaServerId, extra = {}) {
  const collections = [
    { id: 4, title: 'Peliculas Salvadas por 15 días', type: 'movie', libraryId: '5', deleteAfterDays: 15, media: [{ mediaServerId }] },
  ];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.endsWith('/api/collections')) return new Response(JSON.stringify(collections), { status: 200 });
    if (u.includes('/media/handle')) return new Response(JSON.stringify({}), { status: 200 });
    if (u.includes('api.telegram.org')) return new Response(JSON.stringify({ ok: true, result: { message_id: 777, chat: { id: -100123 } } }), { status: 200 });
    if (extra.tautulli && u.startsWith('http://tautulli.test')) return extra.tautulli(u, options);
    throw new Error(`fetch inesperado en test: ${u}`);
  };
  return { fetchImpl, calls };
}

test('processSalvados: todos la han visto → borra 24h después del último, vía media/handle', async () => {
  db.exec("DELETE FROM salvados; DELETE FROM maintainerr_candidates; DELETE FROM salvado_messages;");
  insertCandidateRow.run('ps-1', new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '), 7, 1);
  db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at, watched_at)
    VALUES ('ps-1', NULL, 'Test', '111', 'David', NULL, NULL, datetime('now', '-5 days'), datetime('now', '+1 day'), datetime('now', '-2 days')),
           ('ps-1', NULL, 'Test', '222', 'Ana', NULL, NULL, datetime('now', '-4 days'), datetime('now', '+1 day'), datetime('now', '-1 days'))
  `).run();
  insertSalvadoMessageRow.run('ps-1', '✅ Salvada por David.\n\n✅ Salvada también por Ana.');

  const { fetchImpl, calls } = targetCollectionsFetch('ps-1');
  global.fetch = fetchImpl;

  await processSalvados();

  const handleCall = calls.find((c) => c.url.includes('/media/handle'));
  assert.ok(handleCall, 'debería haber llamado a media/handle');
  assert.deepEqual(JSON.parse(handleCall.options.body), { collectionId: 4, mediaId: 'ps-1' });

  // La fila no se borra (el historial de la pestaña Salvadas la necesita
  // viva) — se marca resuelta.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM salvados WHERE media_server_id = 'ps-1' AND resolved_at IS NULL").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM salvados WHERE media_server_id = 'ps-1'").get().n, 2);
  assert.equal(db.prepare("SELECT 1 FROM maintainerr_candidates WHERE media_server_id = 'ps-1'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM salvado_messages WHERE media_server_id = 'ps-1'").get(), undefined);

  const telegramEdit = calls.find((c) => c.url.includes('editMessage'));
  const body = JSON.parse(telegramEdit.options.body);
  assert.match(body.text, /Borrada\./);
  assert.deepEqual(body.reply_markup, { inline_keyboard: [] });
});

test('processSalvados: falta gente por ver → no borra, expires_at queda en el peor caso conocido', async () => {
  db.exec("DELETE FROM salvados; DELETE FROM maintainerr_candidates; DELETE FROM salvado_messages;");
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  insertCandidateRow.run('ps-2', new Date().toISOString().slice(0, 19).replace('T', ' '), 7, 0);
  db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at, watched_at)
    VALUES ('ps-2', NULL, 'Test', '111', 'David', 501, NULL, datetime('now'), datetime('now', '+1 day'), NULL)
  `).run();

  const { fetchImpl, calls } = targetCollectionsFetch('ps-2', {
    tautulli: async (u) => {
      const cmd = new URL(u).searchParams.get('cmd');
      if (cmd === 'get_history') return new Response(JSON.stringify({ response: { result: 'success', data: { data: [] } } }), { status: 200 });
      throw new Error(`unexpected tautulli cmd ${cmd}`);
    },
  });
  global.fetch = fetchImpl;

  try {
    await processSalvados();
  } finally {
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }

  assert.equal(calls.some((c) => c.url.includes('/media/handle')), false);
  const row = db.prepare("SELECT * FROM salvados WHERE media_server_id = 'ps-2'").get();
  assert.ok(row, 'la fila sigue viva');
  // Peor caso = ventana (7 días desde notified_at ~ ahora) + 7 días de margen: bien lejos, no caducada.
  assert.ok(new Date(`${row.expires_at.replace(' ', 'T')}Z`).getTime() > Date.now());
});

test('processSalvados: detecta el visionado vía Tautulli (después del salvado) y borra 24h más tarde', async () => {
  db.exec("DELETE FROM salvados; DELETE FROM maintainerr_candidates; DELETE FROM salvado_messages;");
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  insertCandidateRow.run('ps-3', new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '), 7, 1);
  db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at, watched_at)
    VALUES ('ps-3', NULL, 'Test', '111', 'David', 501, NULL, datetime('now', '-2 days'), datetime('now', '+1 day'), NULL)
  `).run();

  const watchedAtSec = Math.floor((Date.now() - 2 * 86_400_000) / 1000); // visto justo tras salvar, hace 2 días
  const { fetchImpl, calls } = targetCollectionsFetch('ps-3', {
    tautulli: async (u) => {
      const cmd = new URL(u).searchParams.get('cmd');
      if (cmd === 'get_history') {
        return new Response(
          JSON.stringify({ response: { result: 'success', data: { data: [{ user_id: 501, date: watchedAtSec, percent_complete: 95 }] } } }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected tautulli cmd ${cmd}`);
    },
  });
  global.fetch = fetchImpl;

  try {
    await processSalvados();
  } finally {
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }

  const handleCall = calls.find((c) => c.url.includes('/media/handle'));
  assert.ok(handleCall, 'watched_at detectado debería disparar el borrado (24h ya pasadas)');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM salvados WHERE media_server_id = 'ps-3' AND resolved_at IS NULL").get().n, 0);
});

test('processSalvados: cierra la ventana de salvar una sola vez, sin borrar todavía', async () => {
  db.exec("DELETE FROM salvados; DELETE FROM maintainerr_candidates; DELETE FROM salvado_messages;");
  // Ventana (7 días) cerrada hace 3 días: notified_at hace 10 días. El plazo
  // de gracia (5 días por defecto) cuenta desde el salvado, NO desde el
  // cierre de ventana — guardado hace 1 día, así que ese plazo (día 4) queda
  // lejos y este test aísla solo el cierre de ventana, sin que dispare borrado.
  insertCandidateRow.run('ps-4', new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '), 7, 0);
  db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at, watched_at)
    VALUES ('ps-4', NULL, 'Test', '111', 'David', NULL, NULL, datetime('now', '-1 days'), datetime('now', '+1 day'), NULL)
  `).run();
  insertSalvadoMessageRow.run('ps-4', '✅ Salvada por David.');

  const { fetchImpl, calls } = targetCollectionsFetch('ps-4');
  global.fetch = fetchImpl;

  await processSalvados();
  const closedEdits = calls.filter((c) => c.url.includes('editMessage') && JSON.parse(c.options.body).text?.includes('Plazo para salvarla cerrado'));
  assert.equal(closedEdits.length, 1);
  assert.equal(db.prepare("SELECT window_closed_notified FROM maintainerr_candidates WHERE media_server_id = 'ps-4'").get().window_closed_notified, 1);
  assert.equal(calls.some((c) => c.url.includes('/media/handle')), false, 'aún dentro del plazo de gracia, no debería borrar');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM salvados WHERE media_server_id = 'ps-4' AND resolved_at IS NULL").get().n, 1);

  // Segunda pasada: no debe repetir el aviso de "plazo cerrado".
  calls.length = 0;
  await processSalvados();
  assert.equal(calls.some((c) => c.url.includes('editMessage') && JSON.parse(c.options.body).text?.includes('Plazo para salvarla cerrado')), false);
});

test('getSalvadosHistory: incluye resueltas y activas de los últimos 30 días, con watched_at/resolved_at', async () => {
  db.exec("DELETE FROM salvados;");
  db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at, watched_at, resolved_at)
    VALUES
      ('ps-5', NULL, 'Vista y borrada', '1', 'David', NULL, NULL, datetime('now', '-10 days'), datetime('now', '-1 days'), datetime('now', '-5 days'), datetime('now', '-4 days')),
      ('ps-6', NULL, 'Aún pendiente', '2', 'Ana', NULL, NULL, datetime('now', '-1 days'), datetime('now', '+5 days'), NULL, NULL),
      ('ps-7', NULL, 'Demasiado vieja', '3', 'Bea', NULL, NULL, datetime('now', '-40 days'), datetime('now', '-30 days'), NULL, datetime('now', '-35 days'))
  `).run();

  const history = getSalvadosHistory(30);
  const ids = history.map((r) => r.media_server_id);
  assert.ok(ids.includes('ps-5'), 'resuelta pero dentro de 30 días debe salir');
  assert.ok(ids.includes('ps-6'), 'activa debe salir');
  assert.ok(!ids.includes('ps-7'), 'fuera de los 30 días no debe salir');

  const vista = history.find((r) => r.media_server_id === 'ps-5');
  assert.ok(vista.watched_at, 'debe conservar watched_at');
  assert.ok(vista.resolved_at, 'debe conservar resolved_at');
});

test('processSalvados: el plazo de gracia es configurable y cuenta desde el salvado, no desde la ventana', async () => {
  db.exec("DELETE FROM salvados; DELETE FROM maintainerr_candidates; DELETE FROM salvado_messages;");
  upsertSetting.run('maintainerr_salvado_grace_days', '2');
  // Ventana larga (20 días, ni cerca de cerrarse) para probar que el plazo NO
  // depende de ella: el salvado es de hace 3 días, plazo de gracia 2 días →
  // ya tocaría borrar, aunque la ventana de salvar siga abierta 17 días más.
  insertCandidateRow.run('ps-8', new Date().toISOString().slice(0, 19).replace('T', ' '), 20, 0);
  db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at, watched_at)
    VALUES ('ps-8', NULL, 'Test', '111', 'David', NULL, NULL, datetime('now', '-3 days'), datetime('now', '+1 day'), NULL)
  `).run();

  try {
    const { fetchImpl, calls } = targetCollectionsFetch('ps-8');
    global.fetch = fetchImpl;
    await processSalvados();
    assert.ok(calls.some((c) => c.url.includes('/media/handle')), 'plazo de gracia (2 días) ya cumplido pese a ventana larga sin cerrar');
  } finally {
    db.prepare("DELETE FROM settings WHERE key = 'maintainerr_salvado_grace_days'").run();
  }
});

test('processSalvados: con varios salvadores, el plazo cuenta desde el ÚLTIMO en sumarse, no desde el primero', async () => {
  db.exec("DELETE FROM salvados; DELETE FROM maintainerr_candidates; DELETE FROM salvado_messages;");
  upsertSetting.run('maintainerr_salvado_grace_days', '5');
  insertCandidateRow.run('ps-9', new Date().toISOString().slice(0, 19).replace('T', ' '), 30, 0);
  db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at, watched_at)
    VALUES
      ('ps-9', NULL, 'Test', '111', 'David', NULL, NULL, datetime('now', '-6 days'), datetime('now', '+1 day'), NULL),
      ('ps-9', NULL, 'Test', '222', 'Ana', NULL, NULL, datetime('now', '-1 days'), datetime('now', '+1 day'), NULL)
  `).run();

  try {
    const { fetchImpl, calls } = targetCollectionsFetch('ps-9');
    global.fetch = fetchImpl;
    await processSalvados();
    // David (hace 6 días) + 5 días de gracia ya habría vencido; Ana (hace 1
    // día) + 5 días de gracia todavía no. Debe ganar el plazo de Ana.
    assert.equal(calls.some((c) => c.url.includes('/media/handle')), false, 'no debe borrar aún: el plazo real es el de Ana (el último salvado)');
    const row = db.prepare("SELECT expires_at FROM salvados WHERE media_server_id = 'ps-9' LIMIT 1").get();
    assert.ok(new Date(`${row.expires_at.replace(' ', 'T')}Z`).getTime() > Date.now());
  } finally {
    db.prepare("DELETE FROM settings WHERE key = 'maintainerr_salvado_grace_days'").run();
  }
});
