import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, computeBalance } from '../src/quota.js';

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
  assert.deepEqual(r.pendingItems, [{ title: 'Matrix', tmdbId: 603, posterUrl: 'https://img/x.jpg' }]);
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
