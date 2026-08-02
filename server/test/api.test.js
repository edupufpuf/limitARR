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
    VALUES (1880, 1777, 4, 1, 3, ?)
  `).run(JSON.stringify([{
    title: 'The Batman',
    mediaType: 'movie',
    tmdbId: 414906,
    seasonNumber: null,
    posterUrl: null,
    unavailable: false,
    watchedPercent: 25,
    ratingKey: null,
  }]));
  db.prepare(`
    INSERT INTO decisions_log
      (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, decision, created_at)
    VALUES (990, 1880, 'ana', 1777, 'The Batman', 'movie', 414906, 'approved', '2026-07-01 12:00:00')
  `).run();
  // Issue #20 en el panel de usuario: fila reciente (mes en curso de verdad,
  // no la fecha fija de arriba) para /me/quota/monthly-history.
  db.prepare(`
    INSERT INTO decisions_log
      (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, decision, created_at)
    VALUES (992, 1880, 'ana', 1777, 'Dune', 'movie', 438631, 'approved', datetime('now'))
  `).run();
  // De otro usuario, para comprobar que /me/ no deja verlo por mucho que se
  // adivine el userId — el cacheId sale de la sesión, no de la URL.
  db.prepare(`
    INSERT INTO decisions_log
      (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, decision, created_at)
    VALUES (993, 9999, 'otro', 1777, 'No es mío', 'movie', 111, 'approved', datetime('now'))
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
    assert.equal(quota.libraries[0].pendingItems[0].title, 'The Batman');
    assert.deepEqual(quota.libraries[0].pendingItems[1], {
      title: 'Matrix',
      mediaType: 'movie',
      tmdbId: 603,
      seasonNumber: null,
      posterUrl: 'https://image.tmdb.org/t/p/w185/matrix.jpg',
      pendingApproval: true,
      requestId: 991,
      requestedAt: '2026-07-13T08:00:00Z',
    });

    const detail = (await plexAgent
      .get('/api/me/quota/pending-detail/1777?tmdbId=414906&mediaType=movie')
      .expect(200)).body;
    assert.equal(detail.requestedAt, '2026-07-01 12:00:00');
    assert.deepEqual(detail.watchers, []);
    await plexAgent
      .get('/api/me/quota/pending-detail/1777?tmdbId=999999&ratingKey=secret')
      .expect(404);

    const history = (await plexAgent.get('/api/me/quota/monthly-history/1777').expect(200)).body;
    assert.deepEqual(history.map((r) => r.media_title), ['Dune']); // no la de 9999, ni la de 2026-07-01
    const historyTotal = (await plexAgent.get('/api/me/quota/monthly-history-total').expect(200)).body;
    assert.deepEqual(historyTotal.map((r) => r.media_title), ['Dune']);

    await plexAgent.put('/api/me/notifications').send({ chatId: '123456' }).expect(200);
    assert.equal(db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = 1880').get().chat_id, '123456');
    await plexAgent.delete('/api/me/notifications').expect(204);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM telegram_links WHERE user_id = 1880').run();
    db.prepare('DELETE FROM quota_cache WHERE user_id = 1880 OR library_id = 1777').run();
    db.prepare('DELETE FROM decisions_log WHERE request_id IN (990, 992, 993)').run();
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

// --- v2: roles (mismo patrón que grupos, sin cupo agregado) ---

test('roles: vienen los 4 por defecto sembrados (Usuario/Amigo/Invitado/Admin)', async () => {
  const roles = (await agent.get('/api/roles').expect(200)).body;
  const names = roles.map((r) => r.name).sort();
  assert.deepEqual(names, ['Admin', 'Amigo', 'Invitado', 'Usuario']);
});

test('roles: crear y listar', async () => {
  const created = await agent.post('/api/roles').send({ name: 'Rol de Prueba' }).expect(200);
  const roles = (await agent.get('/api/roles').expect(200)).body;
  const found = roles.find((r) => r.id === created.body.id);
  assert.equal(found.name, 'Rol de Prueba');
  assert.deepEqual(found.members, []);
});

test('roles: nombre repetido devuelve 409', async () => {
  await agent.post('/api/roles').send({ name: 'Rol Duplicado' }).expect(200);
  await agent.post('/api/roles').send({ name: 'Rol Duplicado' }).expect(409);
});

test('roles: asignar miembros los mueve de rol (máx. un rol por usuario)', async () => {
  const a = (await agent.post('/api/roles').send({ name: 'Rol A' }).expect(200)).body.id;
  const b = (await agent.post('/api/roles').send({ name: 'Rol B' }).expect(200)).body.id;

  await agent.put(`/api/roles/${a}/members`).send({ userIds: [801, 802] }).expect(200);
  await agent.put(`/api/roles/${b}/members`).send({ userIds: [802] }).expect(200);

  const roles = (await agent.get('/api/roles').expect(200)).body;
  assert.deepEqual(roles.find((r) => r.id === a).members, [801]);
  assert.deepEqual(roles.find((r) => r.id === b).members, [802]);
});

test('roles: eliminar limpia miembros y overrides', async () => {
  const id = (await agent.post('/api/roles').send({ name: 'Rol Efímero' }).expect(200)).body.id;
  await agent.put(`/api/roles/${id}/members`).send({ userIds: [901] }).expect(200);
  db.prepare('INSERT INTO role_overrides (role_id, library_id, limit_override) VALUES (?, 9, 3)').run(id);

  await agent.delete(`/api/roles/${id}`).expect(200);

  assert.equal(db.prepare('SELECT 1 FROM roles WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM user_roles WHERE role_id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM role_overrides WHERE role_id = ?').get(id), undefined);
});

test('roles: override por biblioteca acepta límite, caducidad y cupo mensual', async () => {
  const id = (await agent.post('/api/roles').send({ name: 'Rol Overrides' }).expect(200)).body.id;
  await agent.put(`/api/roles/${id}/overrides/42`).send({ limitOverride: 2, expiryOverride: 15, monthlyLimitOverride: 3 }).expect(200);

  const roles = (await agent.get('/api/roles').expect(200)).body;
  const override = roles.find((r) => r.id === id).overrides.find((o) => o.library_id === 42);
  assert.equal(override.limit_override, 2);
  assert.equal(override.expiry_override, 15);
  assert.equal(override.monthly_limit_override, 3);

  await agent.delete(`/api/roles/${id}/overrides/42`).expect(200);
  const rolesAfter = (await agent.get('/api/roles').expect(200)).body;
  assert.equal(rolesAfter.find((r) => r.id === id).overrides.length, 0);
});

// --- v2: temporizador de aprobación (acción puntual sobre una solicitud) ---

test('requests: aplazar y quitar aplazamiento', async () => {
  await agent.post('/api/requests/12345/hold').send({ days: 7 }).expect(200);
  let row = db.prepare('SELECT * FROM request_holds WHERE request_id = ?').get(12345);
  assert.ok(row);

  await agent.delete('/api/requests/12345/hold').expect(200);
  row = db.prepare('SELECT * FROM request_holds WHERE request_id = ?').get(12345);
  assert.equal(row, undefined);
});

test('requests: aplazar sin días válidos devuelve 400', async () => {
  await agent.post('/api/requests/12346/hold').send({ days: 0 }).expect(400);
  await agent.post('/api/requests/12346/hold').send({}).expect(400);
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

test('decisions: las salvadas de Maintainerr aparecen mezcladas como pseudo-decisión', async () => {
  // Nombre distintivo para no mezclar con las filas 'ana' de tests anteriores
  // (decisions_log no se limpia entre tests de este fichero).
  db.exec(`
    INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, decision, created_at) VALUES
      (910, 801, 'zzsalvatest', 5, 'Matrix', 'approved', '2026-01-01 10:00:00')
  `);
  db.exec(`
    INSERT INTO salvados (media_server_id, tmdb_id, title, telegram_user_id, telegram_name, user_id, saved_at, expires_at) VALUES
      ('7001', 603, 'The Matrix', '999', 'zzsalvatest', 801, '2026-01-02 10:00:00', datetime('now', '+15 days'))
  `);

  const all = (await agent.get('/api/decisions?q=zzsalvatest').expect(200)).body;
  assert.equal(all.total, 2);
  // Más reciente primero: la salvada (02 ene) antes que la aprobada (01 ene).
  assert.equal(all.rows[0].decision, 'salvado');
  assert.equal(all.rows[0].media_title, 'The Matrix');
  assert.equal(all.rows[1].decision, 'approved');

  const onlySalvados = (await agent.get('/api/decisions?decision=salvado&q=zzsalvatest').expect(200)).body;
  assert.equal(onlySalvados.total, 1);
  assert.equal(onlySalvados.rows[0].media_title, 'The Matrix');

  const onlyApproved = (await agent.get('/api/decisions?decision=approved&q=zzsalvatest').expect(200)).body;
  assert.equal(onlyApproved.total, 1);
  assert.equal(onlyApproved.rows.some((r) => r.decision === 'salvado'), false);
});

// --- issue de jesusgarrigues (20 jul 2026): quitar del cupo / resetear en el Registro, con deshacer ---

test('quota/dismiss: loguea "dismissed" en el registro y POST /decisions/:id/undo lo deshace', async () => {
  db.exec(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (1999, 'Películas', 'movie', 'standard', 0, 4)
  `);
  db.exec(`
    INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, tmdb_id, decision) VALUES
      (990, 8801, 'ana', 1999, 'Matrix', 603, 'approved')
  `);

  await agent
    .post('/api/quota/dismiss/8801/1999')
    .send({ tmdbId: 603, title: 'Matrix', username: 'ana' })
    .expect(200);

  const logged = (await agent.get('/api/decisions?q=Matrix').expect(200)).body.rows
    .find((r) => r.decision === 'dismissed' && r.username === 'ana');
  assert.ok(logged, 'debe aparecer una fila "dismissed" en el registro');
  assert.equal(logged.undone_at, null);

  await agent.post(`/api/decisions/${logged.id}/undo`).expect(200);
  const afterUndo = (await agent.get('/api/decisions?q=Matrix').expect(200)).body.rows
    .find((r) => r.id === logged.id);
  assert.notEqual(afterUndo.undone_at, null);

  const original = db.prepare('SELECT voided_at FROM decisions_log WHERE request_id = 990').get();
  assert.equal(original.voided_at, null); // deshecho: vuelve a contar

  db.prepare('DELETE FROM decisions_log WHERE user_id = 8801').run();
  db.prepare('DELETE FROM libraries WHERE id = 1999').run();
});

test('quota/reset: loguea "reset" en el registro y se puede deshacer', async () => {
  db.exec(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (1998, 'Películas', 'movie', 'standard', 0, 4)
  `);

  await agent.post('/api/quota/reset/8802/1998').send({ username: 'bea' }).expect(200);
  const logged = (await agent.get('/api/decisions?q=bea').expect(200)).body.rows
    .find((r) => r.decision === 'reset');
  assert.ok(logged, 'debe aparecer una fila "reset" en el registro');
  assert.ok(db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = 8802 AND library_id = 1998').get());

  await agent.post(`/api/decisions/${logged.id}/undo`).expect(200);
  assert.equal(
    db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = 8802 AND library_id = 1998').get(),
    undefined
  );

  db.prepare('DELETE FROM decisions_log WHERE user_id = 8802').run();
  db.prepare('DELETE FROM libraries WHERE id = 1998').run();
});

test('POST /decisions/:id/undo: 404 si no existe o ya no es deshacible', async () => {
  await agent.post('/api/decisions/999999999/undo').expect(404);
});

test('cupo: cargo manual resta un hueco sin tmdb y se quita con el ✕ normal', async () => {
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (1778, 'Series', 'show', 'standard', 1, 4)
  `).run();

  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('http://tautulli.test')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [] } } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const charge = await agent
      .post('/api/quota/manual-charge/1880/1778')
      .send({ title: 'Serie mala bajada a mano', username: 'ana', note: 'Descarga manual, calidad mala en Seerr' })
      .expect(200);
    assert.equal(charge.body.outstanding, 1);
    assert.equal(charge.body.balance, 3); // límite 4 - 1
    assert.equal(charge.body.pendingItems[0].title, 'Serie mala bajada a mano');
    assert.equal(charge.body.pendingItems[0].tmdbId, null);
    assert.equal(charge.body.pendingItems[0].unavailable, false);
    assert.equal(charge.body.pendingItems[0].note, 'Descarga manual, calidad mala en Seerr');

    const row = db
      .prepare(`SELECT * FROM decisions_log WHERE user_id = 1880 AND library_id = 1778 AND decision = 'approved'`)
      .get();
    assert.equal(row.tmdb_id, null);
    assert.equal(row.season_number, null);
    assert.equal(row.media_type, 'tv');
    assert.equal(row.note, 'Descarga manual, calidad mala en Seerr');
    assert.ok(row.request_id < 0, 'el request_id manual debe ser negativo para no chocar con ids reales de Seerr');

    const dismissResult = await agent
      .post('/api/quota/dismiss/1880/1778')
      .send({ title: 'Serie mala bajada a mano' })
      .expect(200);
    assert.equal(dismissResult.body.dismissed, 1);
    assert.equal(dismissResult.body.balance, 4);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE library_id = 1778').run();
    db.prepare('DELETE FROM quota_cache WHERE library_id = 1778').run();
    db.prepare('DELETE FROM libraries WHERE id = 1778').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }
});

// --- v2: cupo mensual — cuenta lo aprobado en el mes, se vea o no ---

test('cupo mensual: cuenta cargos aprobados en el mes, independientemente de si se ven', async () => {
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  upsertSetting.run('seerr_url', 'http://seerr.test');
  upsertSetting.run('seerr_api_key', 'test-key');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit, monthly_quota_enabled, monthly_limit)
    VALUES (1779, 'Películas', 'movie', 'standard', 1, 4, 1, 1)
  `).run();

  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('http://tautulli.test')) {
      const cmd = new URL(url).searchParams.get('cmd');
      const data = cmd === 'get_users' ? [{ user_id: 1890, username: 'ana' }] : { data: [] };
      return new Response(JSON.stringify({ response: { result: 'success', data } }), { status: 200 });
    }
    if (url.startsWith('http://seerr.test')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const first = await agent
      .post('/api/quota/manual-charge/1890/1779')
      .send({ title: 'Vista fuera de Seerr 1' })
      .expect(200);
    assert.deepEqual(first.body.monthly, { enabled: true, limit: 1, used: 1, remaining: 0 });

    // Un segundo cargo manual sigue aplicándose (acción del admin, no pasa por
    // el tope): el mensual queda en 2/1, por encima del límite, y así se enseña.
    const second = await agent
      .post('/api/quota/manual-charge/1890/1779')
      .send({ title: 'Vista fuera de Seerr 2' })
      .expect(200);
    assert.deepEqual(second.body.monthly, { enabled: true, limit: 1, used: 2, remaining: 0 });

    const quota = (await agent.get('/api/quota').expect(200)).body;
    const lib = quota.find((u) => u.userId === 1890)?.libraries.find((l) => l.libraryId === 1779);
    assert.deepEqual(lib.monthly, { enabled: true, limit: 1, used: 2 });

    // Issue #20: el historial detrás del contador trae las mismas 2 filas.
    const history = (await agent.get('/api/quota/monthly-history/1890/1779').expect(200)).body;
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((r) => r.media_title).sort(),
      ['Vista fuera de Seerr 1', 'Vista fuera de Seerr 2']
    );
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE library_id = 1779').run();
    db.prepare('DELETE FROM quota_cache WHERE library_id = 1779').run();
    db.prepare('DELETE FROM libraries WHERE id = 1779').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key')").run();
  }
});

test('GET /quota: recentlyWatched trae lo visto en los últimos 30 días, no lo más viejo', async () => {
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  upsertSetting.run('seerr_url', 'http://seerr.test');
  upsertSetting.run('seerr_api_key', 'test-key');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (1782, 'Películas', 'movie', 'standard', 1, 4)
  `).run();
  db.prepare('INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance) VALUES (1892, 1782, 4, 0, 4)').run();
  db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, library_id, media_title, poster_url, decision, created_at)
    VALUES (-9101, 1892, 1782, 'Vista hace poco', 'https://image.tmdb.org/x.jpg', 'watched', datetime('now', '-5 days'))
  `).run();
  db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, library_id, media_title, decision, created_at)
    VALUES (-9102, 1892, 1782, 'Vista hace 40 días', 'watched', datetime('now', '-40 days'))
  `).run();

  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('http://tautulli.test')) {
      const cmd = new URL(url).searchParams.get('cmd');
      const data = cmd === 'get_users' ? [{ user_id: 1892, username: 'jesus' }] : { data: [] };
      return new Response(JSON.stringify({ response: { result: 'success', data } }), { status: 200 });
    }
    if (url.startsWith('http://seerr.test')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const quota = (await agent.get('/api/quota').expect(200)).body;
    const user = quota.find((u) => u.userId === 1892);
    assert.deepEqual(user.recentlyWatched.map((r) => r.title), ['Vista hace poco']);
    assert.equal(user.recentlyWatched[0].posterUrl, 'https://image.tmdb.org/x.jpg');
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE library_id = 1782').run();
    db.prepare('DELETE FROM quota_cache WHERE library_id = 1782').run();
    db.prepare('DELETE FROM libraries WHERE id = 1782').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key')").run();
  }
});

test('cupo mensual total: el historial trae las filas aprobadas de todas las bibliotecas', async () => {
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (1781, 'Películas', 'movie', 'standard', 1, 4)
  `).run();
  db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, decision, created_at)
    VALUES (-9001, 1891, 'bea', 1781, 'Película del mes', 'approved', datetime('now'))
  `).run();

  try {
    const history = (await agent.get('/api/quota/monthly-history-total/1891').expect(200)).body;
    assert.equal(history.length, 1);
    assert.equal(history[0].media_title, 'Película del mes');
    assert.equal(history[0].library_id, 1781);
  } finally {
    db.prepare('DELETE FROM decisions_log WHERE library_id = 1781').run();
    db.prepare('DELETE FROM libraries WHERE id = 1781').run();
  }
});

test('cupo: recalcular todos limpia la caché de usuarios que ya no están activos en Tautulli', async () => {
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (1780, 'Series', 'show', 'standard', 1, 4)
  `).run();
  // Fila fantasma: alguien a quien ya se le quitó el compartido en Plex
  // (deleted_user en Tautulli), pero quota_cache aún lo recuerda de antes.
  db.prepare(`
    INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance)
    VALUES (999999, 1780, 4, 1, 3)
  `).run();

  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('http://tautulli.test')) {
      const cmd = new URL(url).searchParams.get('cmd');
      if (cmd === 'get_users') {
        // Ya no incluye al 999999: se le quitó el compartido.
        return new Response(JSON.stringify({ response: { result: 'success', data: [] } }), { status: 200 });
      }
      throw new Error(`unexpected tautulli cmd ${cmd}`);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const result = await agent.post('/api/quota/recalculate').expect(200);
    assert.equal(result.body.removed, 1);

    const row = db.prepare('SELECT 1 FROM quota_cache WHERE user_id = 999999').get();
    assert.equal(row, undefined);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM quota_cache WHERE library_id = 1780').run();
    db.prepare('DELETE FROM libraries WHERE id = 1780').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }
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

// --- cargo manual desde el buscador de Plex ---

test('GET /media/plex-search: busca en Tautulli y resuelve el poster por tmdbId vía Seerr', async () => {
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  upsertSetting.run('seerr_url', 'http://seerr.test');
  upsertSetting.run('seerr_api_key', 'test-key');

  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=search')) {
      return new Response(JSON.stringify({
        response: {
          result: 'success',
          data: { results_list: { movie: [{ rating_key: '555', title: 'Interestelar', guids: ['tmdb://157336'] }] } },
        },
      }), { status: 200 });
    }
    if (url === 'http://seerr.test/api/v1/movie/157336') {
      return new Response(JSON.stringify({ title: 'Interestelar', posterPath: '/interestelar.jpg' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const res = await agent.get('/api/media/plex-search?q=interestelar').expect(200);
    assert.deepEqual(res.body.results, [
      { title: 'Interestelar', posterUrl: 'https://image.tmdb.org/t/p/w185/interestelar.jpg' },
    ]);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key')").run();
  }
});

test('GET /media/plex-search?mediaType=tv: temporadas sueltas con título "Serie - Temporada N"', async () => {
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'test-key');
  upsertSetting.run('seerr_url', 'http://seerr.test');
  upsertSetting.run('seerr_api_key', 'test-key');

  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=search')) {
      return new Response(JSON.stringify({
        response: {
          result: 'success',
          data: {
            results_list: {
              season: [{ rating_key: '777', title: 'Temporada 1', parent_title: 'La nena', media_index: '1', guids: ['tmdb://281041'] }],
            },
          },
        },
      }), { status: 200 });
    }
    if (url === 'http://seerr.test/api/v1/tv/281041') {
      return new Response(JSON.stringify({ name: 'La nena', seasons: [], posterPath: '/lanena.jpg' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const res = await agent.get('/api/media/plex-search?q=nena&mediaType=tv').expect(200);
    assert.deepEqual(res.body.results, [
      { title: 'La nena - Temporada 1', posterUrl: 'https://image.tmdb.org/t/p/w185/lanena.jpg' },
    ]);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key')").run();
  }
});

test('POST /quota/manual-charge: acepta posterUrl y no lo pisa a null', async () => {
  // enabled=0 a propósito: refreshQuotaCache corta antes de llamar a Tautulli/Seerr
  // (ver comentario de cabecera del archivo) — aquí solo interesa comprobar que la
  // ruta pasa posterUrl a addManualCharge, no el recálculo completo del cupo.
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (1888, 'Películas', 'movie', 'standard', 0, 4)
  `).run();

  await agent
    .post('/api/quota/manual-charge/9001/1888')
    .send({ title: 'Interestelar', note: 'ya en Plex', posterUrl: 'https://image.tmdb.org/t/p/w185/interestelar.jpg' })
    .expect(200);

  const row = db.prepare(
    "SELECT tmdb_id, poster_url FROM decisions_log WHERE user_id = 9001 AND library_id = 1888"
  ).get();
  assert.equal(row.tmdb_id, null);
  assert.equal(row.poster_url, 'https://image.tmdb.org/t/p/w185/interestelar.jpg');

  db.prepare('DELETE FROM decisions_log WHERE user_id = 9001').run();
  db.prepare('DELETE FROM quota_cache WHERE user_id = 9001').run();
  db.prepare('DELETE FROM libraries WHERE id = 1888').run();
});
