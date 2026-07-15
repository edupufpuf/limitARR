import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { getWebhookSecret } from '../src/auth.js';
import { getSalvadosByUser, getAllSalvados } from '../src/services/maintainerr.js';

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
  upsertSetting.run('maintainerr_salvados_collections', 'Peliculas Salvadas por 15 días');
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

test('salvados: registro consultable por usuario y en total, caducados fuera', () => {
  db.prepare('DELETE FROM salvados').run();
  const insert = db.prepare(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, saved_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `);
  insert.run('9010', 414906, 'The Batman', '111', 'Jesús', 1880, "datetime('now')");
  db.prepare("UPDATE salvados SET expires_at = datetime('now', '+15 days') WHERE media_server_id = '9010'").run();
  insert.run('9011', 550, 'Fight Club', '222', 'Amparo', 1880, "x");
  db.prepare("UPDATE salvados SET expires_at = datetime('now', '-1 day') WHERE media_server_id = '9011'").run();

  const own = getSalvadosByUser(1880);
  assert.equal(own.length, 1);
  assert.equal(own[0].title, 'The Batman');
  assert.equal(getAllSalvados().length, 1);
});

test('endpoints admin: /salvados y settings del módulo responden', async () => {
  const salvados = await agent.get('/api/salvados').expect(200);
  assert.ok(Array.isArray(salvados.body));

  const settings = await agent.get('/api/maintainerr/settings').expect(200);
  assert.equal(settings.body.enabled, true);
  assert.match(settings.body.webhookUrl, /\/api\/webhook\/maintainerr\//);
  assert.equal(settings.body.bot_token_set, true);
});
