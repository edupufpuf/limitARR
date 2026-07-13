import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';

// Tests de rutas con la DB en memoria (DB_PATH=:memory: en npm test). No se
// crean bibliotecas habilitadas a propósito: así refreshQuotaCache corta antes
// de llamar a Tautulli/Seerr y los tests no tocan la red.

const app = createApp();
const agent = request.agent(app); // conserva la cookie de sesión entre llamadas

before(async () => {
  await agent.post('/api/auth/setup').send({ password: 'secreto-de-test' }).expect(200);
});

test('auth: la sesión creada en el setup vale para rutas protegidas', async () => {
  const res = await agent.get('/api/auth/me').expect(200);
  assert.equal(res.body.authed, true);
  assert.equal(res.body.needsSetup, false);
});

test('auth: sin sesión, las rutas protegidas devuelven 401', async () => {
  await request(app).get('/api/overrides').expect(401);
});

test('auth: un segundo setup se rechaza con 409', async () => {
  await request(app).post('/api/auth/setup').send({ password: 'otra-cosa-123' }).expect(409);
});

test('auth Plex: usuario normal solo ve su cupo y gestiona su propio chat', async () => {
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  upsertSetting.run('seerr_url', 'http://seerr.test');
  upsertSetting.run('seerr_api_key', 'test-key');
  db.prepare("DELETE FROM settings WHERE key = 'plex_token'").run();
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (1777, 'Películas', 'movie', 'standard', 1, 4)
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance, pending_items)
    VALUES (1880, 1777, 4, 1, 3, '[]')
  `).run();

  const originalFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes('/api/v2/pins?')) return new Response(JSON.stringify({ id: 99, code: 'plex-code' }), { status: 200 });
    if (url.includes('/api/v2/pins/99')) return new Response(JSON.stringify({ authToken: 'user-token' }), { status: 200 });
    if (url.endsWith('/api/v2/user')) {
      return new Response(JSON.stringify({ id: 8800, username: 'ana', email: 'ana@example.test' }), { status: 200 });
    }
    if (url.startsWith('http://tautulli.test')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: [{ user_id: '1880', username: 'ana', friendly_name: 'Ana', email: 'ana@example.test', is_admin: '0' }] } }), { status: 200 });
    }
    if (url.startsWith('http://seerr.test/api/v1/request?filter=pending') && url.includes('mediaType=movie')) {
      return new Response(JSON.stringify({
        results: [{
          id: 991,
          status: 1,
          type: 'movie',
          media: { mediaType: 'movie', tmdbId: 603 },
          createdAt: '2026-07-13T08:00:00Z',
          requestedBy: { id: 44, email: 'ana@example.test', plexUsername: 'ana' },
        }],
        pageInfo: { results: 1 },
      }), { status: 200 });
    }
    if (url.startsWith('http://seerr.test/api/v1/request?filter=pending')) {
      return new Response(JSON.stringify({ results: [], pageInfo: { results: 0 } }), { status: 200 });
    }
    if (url === 'http://seerr.test/api/v1/movie/603') {
      return new Response(JSON.stringify({ title: 'Matrix', posterPath: '/matrix.jpg' }), { status: 200 });
    }
    if (url.startsWith('http://seerr.test')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url} ${options.method || 'GET'}`);
  };

  try {
    const plexAgent = request.agent(app);
    const start = await plexAgent.post('/api/auth/plex/start').expect(200);
    assert.match(start.body.authUrl, /^https:\/\/app\.plex\.tv\/auth/);
    const login = await plexAgent.post('/api/auth/plex/check').expect(200);
    assert.equal(login.body.role, 'user');

    await plexAgent.get('/api/settings').expect(403);
    const quota = (await plexAgent.get('/api/me/quota').expect(200)).body;
    assert.equal(quota.userId, 1880);
    assert.equal(quota.libraries[0].balance, 3);
    assert.deepEqual(quota.libraries[0].pendingItems, [{
      title: 'Matrix',
      mediaType: 'movie',
      tmdbId: 603,
      seasonNumber: null,
      posterUrl: 'https://image.tmdb.org/t/p/w185/matrix.jpg',
      pendingApproval: true,
      requestId: 991,
      requestedAt: '2026-07-13T08:00:00Z',
    }]);

    await plexAgent.put('/api/me/notifications').send({ chatId: '123456' }).expect(200);
    assert.equal(db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = 1880').get().chat_id, '123456');
    await plexAgent.delete('/api/me/notifications').expect(204);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM telegram_links WHERE user_id = 1880').run();
    db.prepare('DELETE FROM quota_cache WHERE user_id = 1880 OR library_id = 1777').run();
    db.prepare('DELETE FROM libraries WHERE id = 1777').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key')").run();
  }
});

test('grupos: crear con cupo agregado y listarlo', async () => {
  const created = await agent.post('/api/groups').send({ name: 'Familia', aggregated: true }).expect(200);
  const groups = (await agent.get('/api/groups').expect(200)).body;
  const familia = groups.find((g) => g.id === created.body.id);
  assert.equal(familia.aggregated, 1);
  assert.deepEqual(familia.members, []);
});

test('grupos: nombre repetido devuelve 409', async () => {
  await agent.post('/api/groups').send({ name: 'Duplicado' }).expect(200);
  await agent.post('/api/groups').send({ name: 'Duplicado' }).expect(409);
});

test('grupos: asignar miembros los mueve de grupo (máx. un grupo por usuario)', async () => {
  const a = (await agent.post('/api/groups').send({ name: 'Grupo A' }).expect(200)).body.id;
  const b = (await agent.post('/api/groups').send({ name: 'Grupo B' }).expect(200)).body.id;

  await agent.put(`/api/groups/${a}/members`).send({ userIds: [501, 502] }).expect(200);
  await agent.put(`/api/groups/${b}/members`).send({ userIds: [502] }).expect(200);

  const groups = (await agent.get('/api/groups').expect(200)).body;
  assert.deepEqual(groups.find((g) => g.id === a).members, [501]);
  assert.deepEqual(groups.find((g) => g.id === b).members, [502]);
});

test('grupos: desactivar el cupo agregado borra la fila de caché del grupo', async () => {
  const id = (await agent.post('/api/groups').send({ name: 'Agregado', aggregated: true }).expect(200)).body.id;
  db.prepare(`
    INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance)
    VALUES (?, 1, 4, 2, 2)
  `).run(-id);

  await agent.put(`/api/groups/${id}`).send({ aggregated: false }).expect(200);

  const row = db.prepare('SELECT 1 FROM quota_cache WHERE user_id = ?').get(-id);
  assert.equal(row, undefined);
});

test('grupos: eliminar un grupo agregado limpia miembros, overrides y caché', async () => {
  const id = (await agent.post('/api/groups').send({ name: 'Efímero', aggregated: true }).expect(200)).body.id;
  await agent.put(`/api/groups/${id}/members`).send({ userIds: [601] }).expect(200);
  db.prepare('INSERT INTO group_overrides (group_id, library_id, limit_override) VALUES (?, 9, 3)').run(id);
  db.prepare(`
    INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance)
    VALUES (?, 9, 3, 1, 2)
  `).run(-id);

  await agent.delete(`/api/groups/${id}`).expect(200);

  assert.equal(db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM group_members WHERE group_id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM group_overrides WHERE group_id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM quota_cache WHERE user_id = ?').get(-id), undefined);
});

test('grupos: PUT sobre un grupo inexistente devuelve 404', async () => {
  await agent.put('/api/groups/99999').send({ aggregated: true }).expect(404);
});

test('overrides: alta, listado y borrado', async () => {
  await agent.put('/api/overrides/701/42').send({ limitOverride: 2, note: 'castigado' }).expect(200);

  let rows = (await agent.get('/api/overrides').expect(200)).body;
  const row = rows.find((o) => o.user_id === 701 && o.library_id === 42);
  assert.equal(row.limit_override, 2);
  assert.equal(row.note, 'castigado');

  await agent.delete('/api/overrides/701/42').expect(200);
  rows = (await agent.get('/api/overrides').expect(200)).body;
  assert.equal(rows.some((o) => o.user_id === 701 && o.library_id === 42), false);
});

test('overrides: 0 se guarda como límite válido (bloqueo total)', async () => {
  await agent.put('/api/overrides/702/42').send({ limitOverride: 0 }).expect(200);
  const rows = (await agent.get('/api/overrides').expect(200)).body;
  assert.equal(rows.find((o) => o.user_id === 702 && o.library_id === 42).limit_override, 0);
});

test('decisions: filtra por decisión y por texto', async () => {
  db.exec(`
    INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, decision) VALUES
      (900, 801, 'ana', 5, 'Matrix', 'approved'),
      (901, 801, 'ana', 5, 'Heat', 'no_quota'),
      (902, 802, 'bea', 5, 'Matrix', 'approved')
  `);

  const approved = (await agent.get('/api/decisions?decision=approved').expect(200)).body;
  assert.equal(approved.total, 2);

  const ana = (await agent.get('/api/decisions?q=ana').expect(200)).body;
  assert.equal(ana.total, 2);
  assert.equal(ana.rows.every((r) => r.username === 'ana'), true);
});

test('notifications: los toggles de aviso se guardan y se leen', async () => {
  let s = (await agent.get('/api/notifications/settings').expect(200)).body;
  assert.equal(s.notifyApproved, true); // default ON
  assert.equal(s.notifyFreed, true);

  s = (await agent.put('/api/notifications/settings').send({ notifyApproved: false }).expect(200)).body;
  assert.equal(s.notifyApproved, false);
  assert.equal(s.notifyFreed, true); // el otro no cambia
});

test('notifications: chat pegado en formato Tautulli "chat/topic" se separa al guardar', async () => {
  let s = (await agent
    .put('/api/notifications/settings')
    .send({ mode: 'group', groupChatId: '-1001234567890/42' })
    .expect(200)).body;
  assert.equal(s.groupChatId, '-1001234567890');
  assert.equal(s.groupTopicId, '42');

  // Un topic explícito gana sobre el pegado al chat.
  s = (await agent
    .put('/api/notifications/settings')
    .send({ groupChatId: '-1001234567890/42', groupTopicId: '7' })
    .expect(200)).body;
  assert.equal(s.groupChatId, '-1001234567890');
  assert.equal(s.groupTopicId, '7');
});

test('notifications: el resumen de pendientes acepta forzar el destino en el body', async () => {
  await agent
    .put('/api/notifications/settings')
    .send({ mode: 'group', groupChatId: '', groupTopicId: '' })
    .expect(200);

  // target: 'dm' ignora el modo grupo guardado (sin usuarios vinculados no envía nada).
  const dm = (await agent.post('/api/notifications/pending-summary').send({ target: 'dm' }).expect(200)).body;
  assert.equal(dm.mode, 'dm');

  // target: 'group' sin chat configurado corta con 404.
  await agent.post('/api/notifications/pending-summary').send({ target: 'group' }).expect(404);

  // Un target inválido cae al modo guardado (grupo sin chat → 404).
  await agent.post('/api/notifications/pending-summary').send({ target: 'lo-que-sea' }).expect(404);
});

test('notifications: probar grupo sin nada guardado ni en el body devuelve 404', async () => {
  await agent
    .put('/api/notifications/settings')
    .send({ groupChatId: '', groupTopicId: '' })
    .expect(200);
  await agent.post('/api/notifications/test-group').send({}).expect(404);
  // Con chat en el body (formulario sin guardar) ya no es "no configurado":
  // pasa del 404 e intenta enviar (502 aquí porque no hay bot de verdad).
  const res = await agent
    .post('/api/notifications/test-group')
    .send({ groupChatId: '-100999', groupTopicId: '3' });
  assert.notEqual(res.status, 404);
});
