import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLimitarrUsers, seerrLocalUserId } from '../src/services/users.js';

test('mergeLimitarrUsers une Plex con Seerr y añade las cuentas locales', () => {
  const users = mergeLimitarrUsers(
    [{ id: 321, username: 'plex-user', email: 'same@example.test', isAdmin: false }],
    [
      { id: 41, username: 'matched', email: 'same@example.test', avatar: '/matched.png' },
      { id: 42, username: 'solo-seerr', email: 'local@example.test', avatar: '/local.png' },
    ]
  );
  const plex = users.find((user) => user.id === 321);
  const local = users.find((user) => user.id === seerrLocalUserId(42));
  assert.equal(plex.source, 'plex');
  assert.equal(plex.seerrId, 41);
  assert.equal(local.username, 'solo-seerr');
  assert.equal(local.source, 'seerr');
});
