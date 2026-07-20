import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  computeBalance,
  resolveLimit,
  dismissPendingItem,
  listStaleOutstandingPairs,
  getPendingItemDetail,
  quotaIdentity,
  buildWatchedEpisodeIndex,
  seasonWatchState,
  getSeasonWatchedPercent,
  resolveExpiryDays,
  dropExpiredRows,
  getRequestHold,
  setRequestHold,
  clearRequestHold,
  addManualCharge,
  resetQuota,
  undoQuotaAction,
  setOverride,
  deleteOverride,
  setGroupOverride,
  deleteGroupOverride,
  setRoleOverride,
  deleteRoleOverride,
} from '../src/quota.js';
import { setRawSetting, updateSettings } from '../src/settings.js';
import { db } from '../src/db.js';

test('resolveLimit: el primer override no-null gana, en el orden dado', () => {
  assert.equal(resolveLimit([5, 3], 4), 5);
  assert.equal(resolveLimit([null, 3], 4), 3);
  assert.equal(resolveLimit([null, null], 4), 4);
});

test('resolveLimit: 0 es un override válido, no "sin valor"', () => {
  assert.equal(resolveLimit([0, 3], 4), 0);
  assert.equal(resolveLimit([null, 0], 4), 0);
});

// v2: rol — tercer escalón entre grupo y biblioteca (individual > grupo > rol > biblioteca).
test('resolveLimit: precedencia de 3 niveles (individual > grupo > rol)', () => {
  assert.equal(resolveLimit([5, 3, 7], 4), 5); // individual gana a todos
  assert.equal(resolveLimit([null, 3, 7], 4), 3); // grupo gana a rol
  assert.equal(resolveLimit([null, null, 7], 4), 7); // rol gana a biblioteca
  assert.equal(resolveLimit([null, null, null], 4), 4); // nada: biblioteca
  assert.equal(resolveLimit([null, null, 0], 4), 0); // 0 de rol también es válido
});

test('normalize: acentos y puntuación no importan', () => {
  assert.equal(normalize('Amélie'), normalize('Amelie'));
  assert.equal(normalize('Río, El (2011)'), normalize('  Rio   El   2011  '));
  assert.equal(normalize('Spider-Man: No Way Home'), normalize('spider man no way home'));
});

test('normalize: título vacío o nulo no rompe', () => {
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(''), '');
});

test('computeBalance: sin aprobadas, saldo completo', () => {
  const r = computeBalance(4, [], new Set());
  assert.equal(r.balance, 4);
  assert.equal(r.outstanding, 0);
  assert.deepEqual(r.pendingItems, []);
});

test('computeBalance: aprobada y no vista resta cupo', () => {
  const approved = [{ media_title: 'Matrix', tmdb_id: 603, poster_url: 'https://img/x.jpg' }];
  const r = computeBalance(1, approved, new Set());
  assert.equal(r.balance, 0);
  assert.equal(r.outstanding, 1);
  assert.deepEqual(r.pendingItems, [
    { title: 'Matrix', mediaType: 'movie', tmdbId: 603, seasonNumber: null, posterUrl: 'https://img/x.jpg', unavailable: false, mediaStatus: null, queueStatus: null, radarrLabel: null, watchedPercent: 0, availableSince: null, expiresAt: null, requestId: null, note: null },
  ]);
});

test('computeBalance: aprobada y vista libera cupo', () => {
  const approved = [{ media_title: 'Matrix', tmdb_id: 603 }];
  const watched = new Set([normalize('Matrix')]);
  const r = computeBalance(1, approved, watched);
  assert.equal(r.balance, 1);
  assert.equal(r.outstanding, 0);
});

test('computeBalance: match de vista tolera acentos/mayúsculas', () => {
  const approved = [{ media_title: 'Amélie', tmdb_id: 194 }];
  const watched = new Set([normalize('amelie')]);
  const r = computeBalance(1, approved, watched);
  assert.equal(r.outstanding, 0);
});

test('computeBalance: nunca baja de 0 aunque haya más aprobadas que límite', () => {
  const approved = [
    { media_title: 'A', tmdb_id: 1 },
    { media_title: 'B', tmdb_id: 2 },
    { media_title: 'C', tmdb_id: 3 },
  ];
  const r = computeBalance(1, approved, new Set());
  assert.equal(r.balance, 0);
  assert.equal(r.outstanding, 3);
});

test('computeBalance: mismo título aprobado dos veces no duplica pendingItems', () => {
  const approved = [
    { media_title: 'Matrix', tmdb_id: 603 },
    { media_title: 'Matrix', tmdb_id: 603 },
  ];
  const r = computeBalance(2, approved, new Set());
  assert.equal(r.outstanding, 2); // sigue restando 2 del cupo
  assert.equal(r.pendingItems.length, 1); // pero solo se muestra una vez
});

// --- issue #1: no contabilizar películas aún no disponibles en Plex ---

test('computeBalance: no disponible aún no resta cupo pero sigue listada', () => {
  const approved = [
    { media_title: 'Matrix', tmdb_id: 603 },
    { media_title: 'Estreno Futuro', tmdb_id: 999 },
  ];
  const r = computeBalance(2, approved, new Set(), new Set([999]));
  assert.equal(r.outstanding, 1); // solo Matrix cuenta
  assert.equal(r.balance, 1);
  assert.deepEqual(
    r.pendingItems.map((i) => [i.title, i.unavailable]),
    [['Matrix', false], ['Estreno Futuro', true]]
  );
});

test('computeBalance: vista gana a no disponible (no aparece en pendientes)', () => {
  const approved = [{ media_title: 'Matrix', tmdb_id: 603 }];
  const r = computeBalance(1, approved, new Set([normalize('Matrix')]), new Set([603]));
  assert.equal(r.outstanding, 0);
  assert.equal(r.balance, 1);
  assert.deepEqual(r.pendingItems, []);
});

test('computeBalance: fila sin tmdb_id nunca se marca no disponible', () => {
  const approved = [{ media_title: 'Vieja Importada', tmdb_id: null }];
  const r = computeBalance(1, approved, new Set(), new Set([999]));
  assert.equal(r.outstanding, 1);
  assert.equal(r.pendingItems[0].unavailable, false);
});

// --- issue #7: % de avance del solicitante en cada pendiente ---

test('computeBalance: pendiente lleva el mayor % de avance del historial', () => {
  const approved = [{ media_title: 'Dune', tmdb_id: 438631 }];
  const percents = new Map([[normalize('Dune'), 62.4]]);
  const r = computeBalance(2, approved, new Set(), new Set(), percents);
  assert.equal(r.outstanding, 1); // 62% < umbral de visto, sigue contando
  assert.equal(r.pendingItems[0].watchedPercent, 62);
});

test('computeBalance: sin historial el avance es 0', () => {
  const approved = [{ media_title: 'Heat', tmdb_id: 949 }];
  const r = computeBalance(2, approved, new Set());
  assert.equal(r.pendingItems[0].watchedPercent, 0);
});

// --- dismissPendingItem (usa la DB en memoria del script de test) ---

const insertDecision = db.prepare(`
  INSERT INTO decisions_log (request_id, user_id, library_id, media_title, tmdb_id, decision)
  VALUES (?, ?, ?, ?, ?, 'approved')
`);
const pendingCount = db.prepare(`
  SELECT COUNT(*) AS n FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND decision = 'approved' AND voided_at IS NULL
`);

test('dismissPendingItem: anula por tmdbId solo la película pedida', () => {
  insertDecision.run(1, 10, 1, 'Matrix', 603);
  insertDecision.run(2, 10, 1, 'Heat', 949);

  const dismissed = dismissPendingItem(10, 1, { tmdbId: 603, title: 'Matrix' });
  assert.equal(dismissed, 1);
  assert.equal(pendingCount.get(10, 1).n, 1); // Heat sigue contando
});

test('dismissPendingItem: sin tmdbId matchea por título normalizado', () => {
  insertDecision.run(3, 11, 1, 'Amélie', null);

  const dismissed = dismissPendingItem(11, 1, { tmdbId: null, title: 'amelie' });
  assert.equal(dismissed, 1);
  assert.equal(pendingCount.get(11, 1).n, 0);
});

test('dismissPendingItem: anula filas duplicadas del mismo título de una vez', () => {
  insertDecision.run(4, 12, 1, 'Matrix', 603);
  insertDecision.run(5, 12, 1, 'Matrix', 603);

  const dismissed = dismissPendingItem(12, 1, { tmdbId: 603, title: 'Matrix' });
  assert.equal(dismissed, 2);
  assert.equal(pendingCount.get(12, 1).n, 0);
});

test('dismissPendingItem: con series, anula solo la temporada pedida (mismo tmdb_id)', () => {
  const insertSeason = db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, library_id, media_title, media_type, tmdb_id, season_number, decision)
    VALUES (?, ?, ?, ?, 'tv', ?, ?, 'approved')
  `);
  insertSeason.run(20, 15, 3, 'Breaking Bad - Temporada 1', 1396, 1);
  insertSeason.run(21, 15, 3, 'Breaking Bad - Temporada 2', 1396, 2);

  const dismissed = dismissPendingItem(15, 3, { tmdbId: 1396, seasonNumber: 2, title: 'Breaking Bad - Temporada 2' });
  assert.equal(dismissed, 1);
  assert.equal(pendingCount.get(15, 3).n, 1); // la temporada 1 sigue contando
});

// --- issue #6: detalle de un pendiente ---

test('getPendingItemDetail: la fecha de solicitud es la fila aprobada más antigua', async () => {
  db.exec(`
    INSERT INTO decisions_log (request_id, user_id, library_id, media_title, tmdb_id, decision, created_at) VALUES
      (30, 20, 1, 'Matrix', 603, 'approved', '2026-07-05 10:00:00'),
      (31, 20, 1, 'Matrix', 603, 'approved', '2026-07-01 10:00:00'),
      (32, 20, 1, 'Heat', 949, 'approved', '2026-06-01 10:00:00')
  `);
  const d = await getPendingItemDetail(20, 1, {
    tmdbId: 603, seasonNumber: null, title: 'Matrix', ratingKey: null, mediaType: 'movie',
  });
  assert.equal(d.requestedAt, '2026-07-01 10:00:00'); // la de Heat no cuenta
  assert.deepEqual(d.watchers, []); // sin ratingKey no se consulta Tautulli
});

// --- issue #5: refresco automático de pares con pendientes ---

const insertLibrary = db.prepare(`
  INSERT INTO libraries (id, name, section_type, enabled) VALUES (?, ?, 'movie', ?)
`);
test('listStaleOutstandingPairs: solo pares con pendientes, caché vieja y biblioteca activa', () => {
  insertLibrary.run(50, 'Películas', 1);
  insertLibrary.run(51, 'Deshabilitada', 0);
  const old = "datetime('now', '-10 minutes')";
  db.exec(`
    INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance, computed_at) VALUES
      (100, 50, 4, 2, 2, ${old}),            -- pendiente y viejo: SÍ
      (101, 50, 4, 0, 4, ${old}),            -- sin pendientes: no
      (102, 50, 4, 1, 3, datetime('now')),   -- recién calculado: no
      (103, 51, 4, 3, 1, ${old})             -- biblioteca deshabilitada: no
  `);

  const pairs = listStaleOutstandingPairs(5);
  assert.deepEqual(pairs, [{ user_id: 100, library_id: 50 }]);
});

test('listStaleOutstandingPairs: pendientes no disponibles cuentan aunque outstanding sea 0', () => {
  // Caso "La Infiltrada": única solicitud del usuario aún no disponible en Plex
  // → outstanding 0, pero al llegar a Plex debe pasar a restar sin recalcular a mano.
  const old = "datetime('now', '-10 minutes')";
  db.exec(`
    INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance, pending_items, computed_at) VALUES
      (104, 50, 4, 0, 4, '[{"title":"La Infiltrada","unavailable":true}]', ${old}),
      (105, 50, 4, 0, 4, '[{"title":"Heat","unavailable":false}]', ${old})
  `);

  const pairs = listStaleOutstandingPairs(5);
  assert.equal(pairs.some((p) => p.user_id === 104), true);
  assert.equal(pairs.some((p) => p.user_id === 105), false);
});

test('listStaleOutstandingPairs: el umbral de minutos se respeta', () => {
  db.exec(`
    INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance, computed_at)
    VALUES (110, 50, 4, 1, 3, datetime('now', '-3 minutes'))
  `);

  assert.equal(listStaleOutstandingPairs(5).some((p) => p.user_id === 110), false);
  assert.equal(listStaleOutstandingPairs(2).some((p) => p.user_id === 110), true);
});

// --- cargo manual desde el buscador de Plex (película ya en Plex, nunca pedida en Seerr) ---

test('addManualCharge: guarda posterUrl pero tmdb_id siempre null (no dispara chequeo de Seerr)', () => {
  insertLibrary.run(60, 'Películas', 1);
  addManualCharge(200, 60, 'Interestelar', 'ana', 'ya estaba en Plex', 'https://image.tmdb.org/t/p/w185/x.jpg');

  const row = db.prepare(
    "SELECT tmdb_id, poster_url, note, decision FROM decisions_log WHERE user_id = 200 AND library_id = 60"
  ).get();
  assert.equal(row.tmdb_id, null);
  assert.equal(row.poster_url, 'https://image.tmdb.org/t/p/w185/x.jpg');
  assert.equal(row.note, 'ya estaba en Plex');
  assert.equal(row.decision, 'approved');

  // Sin tmdb_id, computeBalance nunca la marca "no disponible": no depende de Seerr.
  const approved = [{ media_title: 'Interestelar', tmdb_id: null, poster_url: row.poster_url }];
  const r = computeBalance(4, approved, new Set());
  assert.equal(r.pendingItems[0].unavailable, false);
  assert.equal(r.pendingItems[0].posterUrl, row.poster_url);
});

// --- issue #4: cupo grupal agregado (el grupo cuenta como un solo usuario) ---

db.exec(`
  INSERT INTO groups (id, name, aggregated) VALUES (90, 'Familia', 1), (91, 'Amigos', 0);
  INSERT INTO group_members (user_id, group_id) VALUES (201, 90), (202, 90), (203, 91);
`);

test('quotaIdentity: miembro de grupo agregado resuelve a -group_id con todos los miembros', () => {
  const identity = quotaIdentity(201);
  assert.equal(identity.aggregated, true);
  assert.equal(identity.cacheId, -90);
  assert.equal(identity.groupId, 90);
  assert.deepEqual(identity.memberIds.sort(), [201, 202]);
});

test('quotaIdentity: grupo sin agregar no cambia la identidad del usuario', () => {
  const identity = quotaIdentity(203);
  assert.equal(identity.aggregated, false);
  assert.equal(identity.cacheId, 203);
  assert.deepEqual(identity.memberIds, [203]);
});

test('quotaIdentity: usuario sin grupo es él mismo', () => {
  const identity = quotaIdentity(999);
  assert.equal(identity.aggregated, false);
  assert.equal(identity.cacheId, 999);
  assert.deepEqual(identity.memberIds, [999]);
});

test('quotaIdentity: un id negativo resuelve directamente al grupo', () => {
  const identity = quotaIdentity(-90);
  assert.equal(identity.aggregated, true);
  assert.equal(identity.cacheId, -90);
  assert.deepEqual(identity.memberIds.sort(), [201, 202]);
});

test('quotaIdentity: acepta ids como texto (params de ruta)', () => {
  assert.equal(quotaIdentity('201').cacheId, -90);
  assert.equal(quotaIdentity('-90').groupId, 90);
});

test('dismissPendingItem: sobre un grupo agregado anula el pendiente de cualquier miembro', () => {
  insertDecision.run(40, 202, 1, 'Matrix', 603);

  // Se pide con el id del grupo (como hace el panel) pero la fila es del miembro 202.
  const dismissed = dismissPendingItem(-90, 1, { tmdbId: 603, title: 'Matrix' });
  assert.equal(dismissed, 1);
  assert.equal(pendingCount.get(202, 1).n, 0);
});

test('getPendingItemDetail: sobre un grupo agregado encuentra filas de todos los miembros', async () => {
  db.exec(`
    INSERT INTO decisions_log (request_id, user_id, library_id, media_title, tmdb_id, decision, created_at) VALUES
      (41, 201, 1, 'Heat', 949, 'approved', '2026-07-03 10:00:00'),
      (42, 202, 1, 'Heat', 949, 'approved', '2026-07-01 10:00:00')
  `);
  const d = await getPendingItemDetail(-90, 1, {
    tmdbId: 949, seasonNumber: null, title: 'Heat', ratingKey: null, mediaType: 'movie',
  });
  assert.equal(d.requestedAt, '2026-07-01 10:00:00'); // la más antigua entre miembros
});

test('dismissPendingItem: no toca a otros usuarios ni otras bibliotecas', () => {
  insertDecision.run(6, 13, 1, 'Heat', 949);
  insertDecision.run(7, 13, 2, 'Heat', 949);
  insertDecision.run(8, 14, 1, 'Heat', 949);

  const dismissed = dismissPendingItem(13, 1, { tmdbId: 949, title: 'Heat' });
  assert.equal(dismissed, 1);
  assert.equal(pendingCount.get(13, 2).n, 1);
  assert.equal(pendingCount.get(14, 1).n, 1);
});

// --- Registro + deshacer de "quitar del cupo"/"resetear" (issue de jesusgarrigues, 20 jul 2026) ---

test('dismissPendingItem: loguea una fila "dismissed" con los ids anulados, deshacer los recupera', async () => {
  insertDecision.run(60, 300, 1, 'Matrix', 603);
  insertDecision.run(61, 300, 1, 'Matrix', 603); // duplicada, misma película

  const dismissed = dismissPendingItem(300, 1, { tmdbId: 603, title: 'Matrix' }, 'ana');
  assert.equal(dismissed, 2);
  assert.equal(pendingCount.get(300, 1).n, 0);

  const logRow = db.prepare(
    "SELECT * FROM decisions_log WHERE user_id = 300 AND decision = 'dismissed'"
  ).get();
  assert.equal(logRow.media_title, 'Matrix');
  assert.equal(logRow.username, 'ana');
  assert.equal(JSON.parse(logRow.undo_data).voidedIds.length, 2);
  assert.equal(logRow.undone_at, null);

  const result = await undoQuotaAction(logRow.id);
  assert.deepEqual(result, { kind: 'user', userId: 300, libraryId: 1 });
  assert.equal(pendingCount.get(300, 1).n, 2); // las dos vuelven a contar

  // no se puede deshacer dos veces
  assert.equal(await undoQuotaAction(logRow.id), null);
});

// Bug real: la fila 'dismissed' del registro salía sin carátula porque
// insertQuotaActionLog no copiaba poster_url de la fila anulada.
test('dismissPendingItem: la fila "dismissed" del registro copia el poster_url del pendiente', () => {
  db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, library_id, media_title, tmdb_id, poster_url, decision)
    VALUES (62, 305, 1, 'Matrix', 603, 'https://img/matrix.jpg', 'approved')
  `).run();

  dismissPendingItem(305, 1, { tmdbId: 603, title: 'Matrix' });
  const logRow = db.prepare("SELECT poster_url FROM decisions_log WHERE user_id = 305 AND decision = 'dismissed'").get();
  assert.equal(logRow.poster_url, 'https://img/matrix.jpg');
});

test('dismissPendingItem: sin coincidencias no loguea nada', () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM decisions_log WHERE decision = 'dismissed'").get().n;
  const dismissed = dismissPendingItem(301, 1, { tmdbId: 999999, title: 'no existe' });
  assert.equal(dismissed, 0);
  const after = db.prepare("SELECT COUNT(*) AS n FROM decisions_log WHERE decision = 'dismissed'").get().n;
  assert.equal(after, before);
});

test('resetQuota: loguea "reset" con el reset_at anterior (null la primera vez), deshacer lo quita', async () => {
  resetQuota(302, 1, 'ana');
  const logRow = db.prepare("SELECT * FROM decisions_log WHERE user_id = 302 AND decision = 'reset'").get();
  assert.equal(JSON.parse(logRow.undo_data).previousResetAt, null);
  assert.ok(db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = 302 AND library_id = 1').get());

  const result = await undoQuotaAction(logRow.id);
  assert.deepEqual(result, { kind: 'user', userId: 302, libraryId: 1 });
  // era la primera vez (sin reset anterior) → deshacer quita la fila entera
  assert.equal(db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = 302 AND library_id = 1').get(), undefined);
});

test('resetQuota: un segundo reset guarda el reset_at anterior, deshacer lo restaura', async () => {
  resetQuota(303, 1);
  const firstResetAt = db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = 303 AND library_id = 1').get().reset_at;

  resetQuota(303, 1);
  const secondLog = db.prepare(
    "SELECT * FROM decisions_log WHERE user_id = 303 AND decision = 'reset' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.equal(JSON.parse(secondLog.undo_data).previousResetAt, firstResetAt);

  await undoQuotaAction(secondLog.id);
  assert.equal(
    db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = 303 AND library_id = 1').get().reset_at,
    firstResetAt
  );
});

test('undoQuotaAction: null si el id no existe o la decisión no es deshacible', async () => {
  assert.equal(await undoQuotaAction(999999), null);
  insertDecision.run(70, 304, 1, 'Matrix', 603); // decision 'approved', no deshacible
  const approvedRow = db.prepare("SELECT id FROM decisions_log WHERE user_id = 304 AND decision = 'approved'").get();
  assert.equal(await undoQuotaAction(approvedRow.id), null);
});

test('addManualCharge: la fila queda deshacible (undo = anularse a sí misma)', async () => {
  insertLibrary.run(65, 'Películas', 1);
  addManualCharge(400, 65, 'Interestelar', 'ana');
  const logRow = db.prepare("SELECT * FROM decisions_log WHERE user_id = 400 AND decision = 'approved'").get();
  assert.equal(JSON.parse(logRow.undo_data).selfIds.length, 1);
  assert.equal(pendingCount.get(400, 65).n, 1);

  const result = await undoQuotaAction(logRow.id);
  assert.deepEqual(result, { kind: 'user', userId: 400, libraryId: 65 });
  assert.equal(pendingCount.get(400, 65).n, 0);
});

test('setOverride/deleteOverride: guardan el valor anterior y lo restauran al deshacer', async () => {
  // Primera vez: no había override → previous null → deshacer lo borra entero.
  setOverride(500, 70, { limitOverride: 3, note: 'primero' }, 'ana');
  let logRow = db.prepare("SELECT * FROM decisions_log WHERE decision = 'override_changed' AND username = 'ana'").get();
  assert.equal(JSON.parse(logRow.undo_data).previous, null);
  await undoQuotaAction(logRow.id);
  assert.equal(db.prepare('SELECT * FROM overrides WHERE user_id = 500 AND library_id = 70').get(), undefined);

  // Segunda vez: ya hay un valor (3) → cambiarlo a 7 guarda el 3 como "previous".
  setOverride(500, 70, { limitOverride: 3, note: 'primero' }, 'ana');
  setOverride(500, 70, { limitOverride: 7, note: 'segundo' }, 'ana');
  const secondLog = db.prepare(
    "SELECT * FROM decisions_log WHERE decision = 'override_changed' AND username = 'ana' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.equal(JSON.parse(secondLog.undo_data).previous.limit_override, 3);
  await undoQuotaAction(secondLog.id);
  assert.equal(db.prepare('SELECT limit_override FROM overrides WHERE user_id = 500 AND library_id = 70').get().limit_override, 3);

  // deleteOverride también loguea y deshacerlo restaura el override borrado.
  const beforeDelete = db.prepare('SELECT COUNT(*) AS n FROM decisions_log WHERE decision = \'override_changed\'').get().n;
  deleteOverride(500, 70, 'ana');
  assert.equal(db.prepare('SELECT * FROM overrides WHERE user_id = 500 AND library_id = 70').get(), undefined);
  const deleteLog = db.prepare(
    "SELECT * FROM decisions_log WHERE decision = 'override_changed' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM decisions_log WHERE decision = \'override_changed\'').get().n > beforeDelete);
  await undoQuotaAction(deleteLog.id);
  // deleteOverride capturó "previous" justo antes de borrar (3, tras el undo
  // anterior), así que deshacerlo restaura 3 — no el 7 de dos pasos atrás.
  assert.equal(db.prepare('SELECT limit_override FROM overrides WHERE user_id = 500 AND library_id = 70').get().limit_override, 3);
});

test('setGroupOverride/deleteGroupOverride: mismo patrón, kind "group" al deshacer', async () => {
  setGroupOverride(10, 70, { limitOverride: 5 }, 'Familia');
  const logRow = db.prepare("SELECT * FROM decisions_log WHERE decision = 'group_override_changed'").get();
  assert.equal(logRow.username, 'Familia');
  assert.equal(JSON.parse(logRow.undo_data).previous, null);

  setGroupOverride(10, 70, { limitOverride: 9 }, 'Familia');
  deleteGroupOverride(10, 70, 'Familia');
  const deleteLog = db.prepare(
    "SELECT * FROM decisions_log WHERE decision = 'group_override_changed' ORDER BY id DESC LIMIT 1"
  ).get();
  const result = await undoQuotaAction(deleteLog.id);
  assert.deepEqual(result, { kind: 'group', groupId: 10, libraryId: 70 });
  assert.equal(db.prepare('SELECT limit_override FROM group_overrides WHERE group_id = 10 AND library_id = 70').get().limit_override, 9);
});

test('setRoleOverride/deleteRoleOverride: mismo patrón, kind "role" al deshacer', async () => {
  setRoleOverride(20, 70, { limitOverride: 4 }, 'Amigo');
  setRoleOverride(20, 70, { limitOverride: 8 }, 'Amigo');
  const logRow = db.prepare(
    "SELECT * FROM decisions_log WHERE decision = 'role_override_changed' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.equal(JSON.parse(logRow.undo_data).previous.limit_override, 4);

  const result = await undoQuotaAction(logRow.id);
  assert.deepEqual(result, { kind: 'role', roleId: 20, libraryId: 70 });
  assert.equal(db.prepare('SELECT limit_override FROM role_overrides WHERE role_id = 20 AND library_id = 70').get().limit_override, 4);
});

test('setRequestHold/clearRequestHold: con contexto quedan en el registro y se pueden deshacer', async () => {
  setRequestHold(9001, 7, { userId: 600, libraryId: 70, username: 'ana', title: 'Dune', posterUrl: 'https://img/dune.jpg' });
  const heldLog = db.prepare("SELECT * FROM decisions_log WHERE decision = 'held' AND user_id = 600").get();
  assert.equal(heldLog.media_title, 'Dune');
  assert.equal(heldLog.poster_url, 'https://img/dune.jpg');
  assert.ok(getRequestHold(9001));

  clearRequestHold(9001, { userId: 600, libraryId: 70, username: 'ana', title: 'Dune' });
  const clearedLog = db.prepare("SELECT * FROM decisions_log WHERE decision = 'hold_cleared' AND user_id = 600").get();
  assert.ok(JSON.parse(clearedLog.undo_data).holdUntil);
  assert.equal(getRequestHold(9001), null);

  const result = await undoQuotaAction(clearedLog.id);
  assert.deepEqual(result, { kind: 'user', userId: 600, libraryId: 70 });
  assert.ok(getRequestHold(9001)); // restaurado

  await undoQuotaAction(heldLog.id);
  assert.equal(getRequestHold(9001), null); // deshacer "aplazar" = quitar el aplazamiento
});

test('setRequestHold/clearRequestHold: sin contexto (uso interno del scheduler) no loguean nada', () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM decisions_log WHERE decision IN ('held','hold_cleared')").get().n;
  setRequestHold(9002, 3);
  clearRequestHold(9002);
  const after = db.prepare("SELECT COUNT(*) AS n FROM decisions_log WHERE decision IN ('held','hold_cleared')").get().n;
  assert.equal(after, before);
});

// Deshacer aprobar/rechazar no es solo local: se rechaza/aprueba también en
// Seerr de verdad (para cancelar/reactivar la descarga), no solo se toca la BD.
test('undoQuotaAction: deshacer "approved" con requestId también rechaza en Seerr', async () => {
  updateSettings({ seerr_url: 'http://seerr.test', seerr_api_key: 'k' });
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (input, options) => {
    calls.push({ url: String(input), method: options?.method });
    return new Response('{}', { status: 200 });
  };

  try {
    db.prepare(`
      INSERT INTO decisions_log (request_id, user_id, library_id, media_title, decision, undo_data)
      VALUES (7001, 700, 1, 'Dune', 'approved', ?)
    `).run(JSON.stringify({ selfIds: [], requestId: 7001 }));
    const logRow = db.prepare("SELECT id FROM decisions_log WHERE request_id = 7001").get();

    await undoQuotaAction(logRow.id);
    assert.ok(calls.some((c) => c.url === 'http://seerr.test/api/v1/request/7001/decline' && c.method === 'POST'));
  } finally {
    global.fetch = originalFetch;
    setRawSetting('seerr_url', '');
    setRawSetting('seerr_api_key', '');
  }
});

test('undoQuotaAction: deshacer "declined" con requestId también aprueba en Seerr', async () => {
  updateSettings({ seerr_url: 'http://seerr.test', seerr_api_key: 'k' });
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (input, options) => {
    calls.push({ url: String(input), method: options?.method });
    return new Response('{}', { status: 200 });
  };

  try {
    db.prepare(`
      INSERT INTO decisions_log (request_id, user_id, library_id, media_title, decision, undo_data)
      VALUES (7002, 701, 1, 'Dune', 'declined', ?)
    `).run(JSON.stringify({ voidedIds: [], requestId: 7002 }));
    const logRow = db.prepare("SELECT id FROM decisions_log WHERE request_id = 7002").get();

    await undoQuotaAction(logRow.id);
    assert.ok(calls.some((c) => c.url === 'http://seerr.test/api/v1/request/7002/approve' && c.method === 'POST'));
  } finally {
    global.fetch = originalFetch;
    setRawSetting('seerr_url', '');
    setRawSetting('seerr_api_key', '');
  }
});

// --- Issue #9: temporadas vistas que no salían del cupo ---

const friendsHistory = [
  // T1: 3 de 4 episodios vistos, uno de ellos con rating_key muerto (re-escaneo
  // de Plex) que solo matchea por serie+temporada+episodio.
  { ratingKey: 'e1', showRatingKey: 'show1', showTitle: 'Friends', seasonNumber: 1, episodeNumber: 1, percent: 95 },
  { ratingKey: 'muerto', showRatingKey: 'show1', showTitle: 'Friends', seasonNumber: 1, episodeNumber: 2, percent: 97 },
  { ratingKey: 'e3', showRatingKey: 'show1', showTitle: 'Friends', seasonNumber: 1, episodeNumber: 3, percent: 40 }, // no llega al 85
  { ratingKey: 'e4', showRatingKey: 'show1', showTitle: 'Friends', seasonNumber: 1, episodeNumber: 4, percent: 90 },
];

const friendsSeason1 = [
  { ratingKey: 'e1', episodeNumber: 1 },
  { ratingKey: 'e2-nuevo', episodeNumber: 2 },
  { ratingKey: 'e3', episodeNumber: 3 },
  { ratingKey: 'e4', episodeNumber: 4 },
];

test('seasonWatchState: episodio con rating_key muerto matchea por serie+temporada+episodio', () => {
  const index = buildWatchedEpisodeIndex(friendsHistory);
  const state = seasonWatchState(index, friendsSeason1, { showTitle: 'Friends', showRatingKey: 'show1', seasonNumber: 1 }, 100);
  assert.equal(state.watchedCount, 3); // e1, e2 (por número), e4 — e3 por debajo del 85
  assert.equal(state.total, 4);
  assert.equal(state.percent, 75);
  assert.equal(state.complete, false); // umbral 100: falta e3
});

test('seasonWatchState: con umbral 75 la temporada ya cuenta como vista', () => {
  const index = buildWatchedEpisodeIndex(friendsHistory);
  const state = seasonWatchState(index, friendsSeason1, { showTitle: 'Friends', showRatingKey: 'show1', seasonNumber: 1 }, 75);
  assert.equal(state.complete, true);
});

test('seasonWatchState: matchea por título aunque cambien todos los rating_keys', () => {
  const index = buildWatchedEpisodeIndex([
    { ratingKey: 'viejo1', showRatingKey: 'viejoShow', showTitle: 'Friends', seasonNumber: 2, episodeNumber: 1, percent: 95 },
  ]);
  const episodes = [{ ratingKey: 'nuevo1', episodeNumber: 1 }];
  const state = seasonWatchState(index, episodes, { showTitle: 'friends', showRatingKey: 'showNuevo', seasonNumber: 2 }, 85);
  assert.equal(state.watchedCount, 1);
  assert.equal(state.complete, true);
});

test('seasonWatchState: temporada sin episodios en Plex nunca cuenta como vista', () => {
  const index = buildWatchedEpisodeIndex(friendsHistory);
  const state = seasonWatchState(index, [], { showTitle: 'Friends', showRatingKey: 'show1', seasonNumber: 9 }, 85);
  assert.equal(state.complete, false);
  assert.equal(state.percent, 0);
});

test('seasonWatchState: un episodio de otra temporada no cuenta', () => {
  const index = buildWatchedEpisodeIndex([
    { ratingKey: 'x', showRatingKey: 'show1', showTitle: 'Friends', seasonNumber: 1, episodeNumber: 1, percent: 95 },
  ]);
  const episodes = [{ ratingKey: 'otro', episodeNumber: 1 }];
  const state = seasonWatchState(index, episodes, { showTitle: 'Friends', showRatingKey: 'show1', seasonNumber: 2 }, 85);
  assert.equal(state.watchedCount, 0);
});

test('getSeasonWatchedPercent: default 85, respeta el ajuste y descarta basura', () => {
  assert.equal(getSeasonWatchedPercent(), 85);
  setRawSetting('tv_season_watched_percent', '70');
  assert.equal(getSeasonWatchedPercent(), 70);
  setRawSetting('tv_season_watched_percent', 'patata');
  assert.equal(getSeasonWatchedPercent(), 85);
  setRawSetting('tv_season_watched_percent', '0');
  assert.equal(getSeasonWatchedPercent(), 85);
  setRawSetting('tv_season_watched_percent', '100');
  assert.equal(getSeasonWatchedPercent(), 100);
});

// --- Issue #10: caducidad de pendientes ---

test('resolveExpiryDays: misma precedencia que el límite y default 30', () => {
  assert.equal(resolveExpiryDays([null, null], null), 30);
  assert.equal(resolveExpiryDays([null, null], 15), 15);
  assert.equal(resolveExpiryDays([null, 10], 15), 10);
  assert.equal(resolveExpiryDays([5, 10], 15), 5);
});

test('resolveExpiryDays: 0 significa "no caduca" en cualquier nivel', () => {
  assert.equal(resolveExpiryDays([0, 10], 15), null);
  assert.equal(resolveExpiryDays([null, 0], 15), null);
  assert.equal(resolveExpiryDays([null, null], 0), null);
});

test('dropExpiredRows: quita las filas más viejas que el plazo y respeta "sin caducidad"', () => {
  const now = Date.parse('2026-07-12T12:00:00Z');
  const rows = [
    { media_title: 'Vieja', created_at: '2026-06-01 12:00:00' },   // 41 días
    { media_title: 'Reciente', created_at: '2026-07-01 12:00:00' }, // 11 días
    { media_title: 'Sin fecha', created_at: null },
  ];
  const kept = dropExpiredRows(rows, 30, now);
  assert.deepEqual(kept.map((r) => r.media_title), ['Reciente', 'Sin fecha']);
  assert.equal(dropExpiredRows(rows, null, now).length, 3); // sin caducidad no filtra
});

test('computeBalance: el pendiente lleva su fecha de caducidad', () => {
  const approved = [{ media_title: 'Matrix', tmdb_id: 603, created_at: '2026-07-01 00:00:00' }];
  const r = computeBalance(2, approved, new Set(), new Set(), new Map(), 30);
  const expected = Date.parse('2026-07-01T00:00:00Z') + 30 * 86_400_000;
  assert.equal(r.pendingItems[0].expiresAt, expected);
  const sinCaducidad = computeBalance(2, approved, new Set(), new Set(), new Map(), null);
  assert.equal(sinCaducidad.pendingItems[0].expiresAt, null);
});

// --- Issue #14: la caducidad cuenta desde la disponibilidad en Plex ---

test('dropExpiredRows: el plazo cuenta desde availableSince, no desde la aprobación', () => {
  const now = Date.parse('2026-07-12T12:00:00Z');
  // Aprobada hace 41 días pero llegó a Plex hace 11: NO caduca.
  const rows = [{ media_title: 'Tardona', tmdb_id: 1, created_at: '2026-06-01 12:00:00' }];
  const availability = new Map([[1, { unavailable: false, availableSince: Date.parse('2026-07-01T12:00:00Z') }]]);
  assert.equal(dropExpiredRows(rows, 30, now, availability).length, 1);
  // Sin dato de disponibilidad se cae a created_at: caduca como antes.
  assert.equal(dropExpiredRows(rows, 30, now, new Map()).length, 0);
});

test('dropExpiredRows: una no disponible nunca caduca', () => {
  const now = Date.parse('2026-07-12T12:00:00Z');
  const rows = [{ media_title: 'Atascada', tmdb_id: 2, created_at: '2026-05-01 12:00:00' }];
  const availability = new Map([[2, { unavailable: true, availableSince: null }]]);
  assert.equal(dropExpiredRows(rows, 30, now, availability).length, 1);
});

test('computeBalance: expiresAt y availableSince salen de la disponibilidad', () => {
  const since = Date.parse('2026-07-01T00:00:00Z');
  const approved = [{ media_title: 'Matrix', tmdb_id: 603, created_at: '2026-06-01 00:00:00' }];
  const availability = new Map([[603, { unavailable: false, availableSince: since }]]);
  const r = computeBalance(2, approved, new Set(), new Set(), new Map(), 30, availability);
  assert.equal(r.pendingItems[0].availableSince, since);
  assert.equal(r.pendingItems[0].expiresAt, since + 30 * 86_400_000);
});

// --- v2: temporizador de aprobación (acción puntual sobre una solicitud) ---

test('setRequestHold/getRequestHold: guarda y lee la fecha de aplazamiento', () => {
  setRequestHold(70001, 7);
  const hold = getRequestHold(70001);
  assert.ok(hold.holdUntil > Date.now()); // dentro de 7 días, en el futuro
  assert.ok(hold.holdUntil <= Date.now() + 7 * 86_400_000 + 1000);
});

test('getRequestHold: sin aplazamiento devuelve null', () => {
  assert.equal(getRequestHold(70002), null);
});

test('clearRequestHold: quita el aplazamiento', () => {
  setRequestHold(70003, 1);
  clearRequestHold(70003);
  assert.equal(getRequestHold(70003), null);
});

test('setRequestHold: repetir sobre la misma solicitud actualiza la fecha', () => {
  setRequestHold(70004, 1);
  const first = getRequestHold(70004).holdUntil;
  setRequestHold(70004, 30);
  const second = getRequestHold(70004).holdUntil;
  assert.ok(second > first);
});

test('computeBalance: una no disponible no lleva fecha de caducidad', () => {
  const approved = [{ media_title: 'Estreno Futuro', tmdb_id: 999, created_at: '2026-06-01 00:00:00' }];
  const availability = new Map([[999, { unavailable: true, status: 3, availableSince: null }]]);
  const r = computeBalance(2, approved, new Set(), new Set([999]), new Map(), 30, availability);
  assert.equal(r.pendingItems[0].unavailable, true);
  assert.equal(r.pendingItems[0].mediaStatus, 3);
  assert.equal(r.pendingItems[0].expiresAt, null);
  assert.equal(r.pendingItems[0].availableSince, null);
});
