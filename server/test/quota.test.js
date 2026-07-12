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
} from '../src/quota.js';
import { db } from '../src/db.js';

test('resolveLimit: individual gana a grupo, grupo gana a biblioteca', () => {
  assert.equal(resolveLimit(5, 3, 4), 5);
  assert.equal(resolveLimit(null, 3, 4), 3);
  assert.equal(resolveLimit(null, null, 4), 4);
});

test('resolveLimit: 0 es un override válido, no "sin valor"', () => {
  assert.equal(resolveLimit(0, 3, 4), 0);
  assert.equal(resolveLimit(null, 0, 4), 0);
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
    { title: 'Matrix', mediaType: 'movie', tmdbId: 603, seasonNumber: null, posterUrl: 'https://img/x.jpg', unavailable: false, watchedPercent: 0 },
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

test('listStaleOutstandingPairs: el umbral de minutos se respeta', () => {
  db.exec(`
    INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance, computed_at)
    VALUES (110, 50, 4, 1, 3, datetime('now', '-3 minutes'))
  `);

  assert.equal(listStaleOutstandingPairs(5).some((p) => p.user_id === 110), false);
  assert.equal(listStaleOutstandingPairs(2).some((p) => p.user_id === 110), true);
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
